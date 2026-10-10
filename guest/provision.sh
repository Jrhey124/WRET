#!/bin/sh
set -eu
# Run inside a fresh Debian 12/13 x64 VM; this does not configure the Windows host.
apt-get update
apt-get install -y chromium python3 python3-websocket nftables
id wret >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin wret
install -m 0755 agent.py /usr/local/lib/wret-agent.py
cat > /etc/udev/rules.d/90-wret.rules <<'EOF'
SUBSYSTEM=="virtio-ports", ATTR{name}=="org.wret.control", MODE="0600", OWNER="wret"
EOF
cat > /etc/nftables.conf <<'EOF'
#!/usr/sbin/nft -f
flush ruleset
table inet wret {
 chain input { type filter hook input priority 0; policy drop; iifname "lo" accept; }
 chain output { type filter hook output priority 0; policy drop; oifname "lo" accept; }
 chain forward { type filter hook forward priority 0; policy drop; }
}
EOF
cat > /etc/systemd/system/wret-agent.service <<'EOF'
[Unit]
Description=WRET isolated guest debugger
After=systemd-udev-settle.service nftables.service
Wants=systemd-udev-settle.service
[Service]
User=wret
Environment=HOME=/tmp/wret-home
ExecStart=/usr/bin/python3 /usr/local/lib/wret-agent.py
Restart=on-failure
RestartSec=2
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
[Install]
WantedBy=multi-user.target
EOF
systemctl enable nftables wret-agent
udevadm control --reload || true
echo 'Power off this guest and copy its qcow2 image to .wret-vm/guest.qcow2 on Windows.'
