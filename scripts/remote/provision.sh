#!/usr/bin/env bash
#
# Provision a fresh Debian 13 or Ubuntu 24.04 host for unattended charrette runs.
#
# The architecture and the threat model are in docs/REMOTE.md. This script only
# applies the parts that can be applied mechanically:
#
#   - one unprivileged user, no sudo, key-only SSH, no root login
#   - Node 22 LTS, pnpm, git, gh, tmux and Tailscale from vendor repositories
#   - unattended security upgrades
#   - an nftables ruleset that keeps outbound traffic on the public internet
#     and away from the private network the host sits on
#   - the env file (0600, placeholders only) and the tmux session wrapper
#
# It never reads, prints or writes a secret value. The env file it writes is
# commented placeholders; the operator fills it in over SSH.
#
# Two environment variables exist so the plan can be tested on a machine that
# is not the target. Neither changes what a real run does:
#
#   CHARRETTE_OS_RELEASE       path to the os-release file (default /etc/os-release)
#   CHARRETTE_PROVISION_ROOT   prefix for every path written (default empty = /)
#
set -euo pipefail

USER_NAME=""
SSH_KEY=""
DRY_RUN=0
OS_RELEASE="${CHARRETTE_OS_RELEASE:-/etc/os-release}"
TARGET_ROOT="${CHARRETTE_PROVISION_ROOT:-}"

usage() {
  cat <<'EOF'
Usage: sudo scripts/remote/provision.sh --user <name> --ssh-key <public-key-path> [--dry-run]

  --user <name>       the unprivileged account that runs charrette
  --ssh-key <path>    the public key installed for that account
  --dry-run           print every change without making it
  -h, --help          this text
EOF
}

die() {
  printf 'provision: %s\n' "$*" >&2
  exit 1
}

say() {
  printf '%s\n' "$*"
}

# Every path this script writes goes through here. Empty for a real run, a
# temporary directory in the tests.
target() {
  printf '%s%s' "$TARGET_ROOT" "$1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      [[ $# -ge 2 ]] || die "--user needs a value"
      USER_NAME="$2"
      shift 2
      ;;
    --ssh-key)
      [[ $# -ge 2 ]] || die "--ssh-key needs a path"
      SSH_KEY="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$USER_NAME" ]] || die "missing --user (see --help)"
[[ "$USER_NAME" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "--user must be a plain lower-case account name"

[[ -n "$SSH_KEY" ]] || die "missing --ssh-key; pass the path to the operator's public key"
[[ -r "$SSH_KEY" ]] || die "--ssh-key is not a readable file: $SSH_KEY"
KEY_LINE="$(head -n 1 "$SSH_KEY")"
read -r KEY_TYPE KEY_BODY _REST <<<"$KEY_LINE"
case "$KEY_TYPE" in
  ssh-ed25519 | ssh-rsa | ecdsa-sha2-* | sk-ssh-ed25519@openssh.com | sk-ecdsa-sha2-nistp256@openssh.com) ;;
  *) die "--ssh-key is not a public key (expected ssh-ed25519, ssh-rsa or ecdsa-sha2-*)" ;;
esac
[[ -n "${KEY_BODY:-}" ]] || die "--ssh-key is not a public key: no key material"

# --- operating system -------------------------------------------------------
[[ -r "$OS_RELEASE" ]] || die "cannot read $OS_RELEASE; this script supports Debian 13 and Ubuntu 24.04"
# shellcheck disable=SC1090
. "$OS_RELEASE"
OS_ID="${ID:-}"
OS_VERSION="${VERSION_ID:-}"
OS_CODENAME="${VERSION_CODENAME:-}"
case "$OS_ID:$OS_VERSION" in
  debian:13) OS_NAME="Debian 13" ;;
  ubuntu:24.04) OS_NAME="Ubuntu 24.04" ;;
  *) die "unsupported OS ${OS_ID:-unknown} ${OS_VERSION:-unknown}; supported: Debian 13 and Ubuntu 24.04" ;;
esac

if [[ "$DRY_RUN" -eq 0 && "${EUID:-$(id -u)}" -ne 0 ]]; then
  die "run as root or with sudo, or pass --dry-run to see the plan"
fi

say "provision: $OS_NAME, user $USER_NAME"
say "provision: root=${TARGET_ROOT:-/} dry-run=$DRY_RUN"

# --- the unprivileged user --------------------------------------------------
if id -u "$USER_NAME" >/dev/null 2>&1; then
  say "user $USER_NAME already exists; leaving it alone"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  say "[dry-run] useradd --create-home --shell /bin/bash --user-group $USER_NAME"
else
  useradd --create-home --shell /bin/bash --user-group "$USER_NAME"
fi

# --- SSH: the operator's key only, no password, no root ---------------------
SSH_DIR="$(target "/home/$USER_NAME/.ssh")"
AUTH_KEYS="$SSH_DIR/authorized_keys"
if [[ "$DRY_RUN" -eq 1 ]]; then
  say "[dry-run] install -d -m 700 -o $USER_NAME -g $USER_NAME $SSH_DIR"
  say "[dry-run] add the key to $AUTH_KEYS (mode 600), once"
else
  install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$SSH_DIR"
  touch "$AUTH_KEYS"
  if ! grep -qxF "$KEY_LINE" "$AUTH_KEYS"; then
    printf '%s\n' "$KEY_LINE" >>"$AUTH_KEYS"
  fi
  chown "$USER_NAME:$USER_NAME" "$AUTH_KEYS"
  chmod 600 "$AUTH_KEYS"
fi

SSHD_DROPIN="$(target "/etc/ssh/sshd_config.d/99-charrette.conf")"
if [[ "$DRY_RUN" -eq 1 ]]; then
  say "[dry-run] write $SSHD_DROPIN: PasswordAuthentication no, PermitRootLogin no"
else
  install -m 0644 -D /dev/stdin "$SSHD_DROPIN" <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
fi

# --- packages ---------------------------------------------------------------
if [[ "$DRY_RUN" -eq 1 ]]; then
  say "[dry-run] apt-get update"
  say "[dry-run] apt-get install -y git gh tmux nftables unattended-upgrades ca-certificates curl gnupg"
  say "[dry-run] install Node 22 LTS from the NodeSource vendor repository"
  say "[dry-run] enable pnpm through corepack"
  say "[dry-run] install tailscale from its vendor repository"
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y git gh tmux nftables unattended-upgrades ca-certificates curl gnupg
  install -m 0755 -d /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --batch --yes --dearmor -o /usr/share/keyrings/nodesource.gpg
  printf 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main\n' \
    >/etc/apt/sources.list.d/nodesource.list
  curl -fsSL "https://pkgs.tailscale.com/stable/${OS_ID}/${OS_CODENAME}.noarmor.gpg" \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  printf 'deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/%s %s main\n' \
    "$OS_ID" "$OS_CODENAME" >/etc/apt/sources.list.d/tailscale.list
  apt-get update
  apt-get install -y nodejs tailscale
  corepack enable
  corepack prepare pnpm@11.22.0 --activate
  systemctl enable --now tailscaled
fi

# --- unattended security upgrades ------------------------------------------
AUTO_UPGRADES="$(target "/etc/apt/apt.conf.d/20auto-upgrades")"
if [[ "$DRY_RUN" -eq 1 ]]; then
  say "[dry-run] enable unattended-upgrades for security updates"
else
  install -m 0644 -D /dev/stdin "$AUTO_UPGRADES" <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  systemctl enable --now unattended-upgrades
fi

# --- nftables: no lateral movement into the private network -----------------
GATEWAY=""
if command -v ip >/dev/null 2>&1; then
  GATEWAY="$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')"
fi
NFT_RULES="$(target "/etc/nftables.d/charrette.conf")"
if [[ "$DRY_RUN" -eq 1 ]]; then
  say "[dry-run] write nftables ruleset to $NFT_RULES"
  say "[dry-run] drop outbound RFC 1918, link-local and CGNAT; allow gateway, DNS and 100.100.100.100"
else
  install -d -m 0755 "$(dirname "$NFT_RULES")"
  {
    printf 'table inet charrette {\n'
    printf '  chain output {\n'
    printf '    type filter hook output priority 0; policy accept;\n'
    printf '    oifname "lo" accept\n'
    printf '    ip daddr 100.100.100.100 accept\n'
    printf '    udp dport 53 accept\n'
    printf '    tcp dport 53 accept\n'
    if [[ -n "$GATEWAY" ]]; then
      printf '    ip daddr %s accept\n' "$GATEWAY"
    fi
    printf '    ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10 } drop\n'
    printf '  }\n'
    printf '}\n'
  } >"$NFT_RULES"
  NFT_CONF="$(target "/etc/nftables.conf")"
  touch "$NFT_CONF"
  if ! grep -qxF "include \"$NFT_RULES\"" "$NFT_CONF"; then
    printf 'include "%s"\n' "$NFT_RULES" >>"$NFT_CONF"
  fi
  systemctl enable --now nftables
  nft -f "$NFT_RULES"
fi

# --- the env file and the tmux wrapper -------------------------------------
ENV_DIR="$(target "/home/$USER_NAME/.config/charrette")"
ENV_FILE="$ENV_DIR/env"
BIN_DIR="$(target "/home/$USER_NAME/bin")"
WRAPPER="$BIN_DIR/charrette-session"
if [[ "$DRY_RUN" -eq 1 ]]; then
  say "[dry-run] write $ENV_FILE (mode 0600) with commented key placeholders, only if absent"
  say "[dry-run] write $WRAPPER, which loads the env file and attaches to tmux session charrette"
else
  install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$ENV_DIR"
  if [[ ! -f "$ENV_FILE" ]]; then
    install -m 0600 -o "$USER_NAME" -g "$USER_NAME" /dev/stdin "$ENV_FILE" <<'EOF'
# Charrette environment. Mode 0600, owned by the charrette user.
# Fill in what this host needs; see docs/REMOTE.md section 6.
# ANTHROPIC_API_KEY=
# CLAUDE_CODE_OAUTH_TOKEN=
# GEMINI_API_KEY=
# DEEPSEEK_API_KEY=
# OPENAI_API_KEY=
# GITHUB_TOKEN=
# CHARRETTE_NOTIFY_URL=
# CHARRETTE_NOTIFY_FORMAT=ntfy
# CHARRETTE_NOTIFY_TOKEN=
EOF
  fi
  install -d -m 0755 -o "$USER_NAME" -g "$USER_NAME" "$BIN_DIR"
  if [[ ! -f "$WRAPPER" ]]; then
    install -m 0755 -o "$USER_NAME" -g "$USER_NAME" /dev/stdin "$WRAPPER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${HOME}/.config/charrette/env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
exec tmux new-session -A -s charrette
EOF
  fi
fi

say "provision: done"
if [[ "$DRY_RUN" -eq 1 ]]; then
  say "provision: nothing was changed"
else
  say "provision: fill in $ENV_FILE, then run $WRAPPER and start a run inside tmux"
fi
