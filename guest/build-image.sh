#!/bin/sh
set -eu
# Run on a Linux builder with guestfs-tools and virtualization available.
template=${WRET_GUEST_TEMPLATE:-debian-12}
output=${1:-guest.qcow2}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test ! -e "$output" || { echo "Refusing to overwrite $output" >&2; exit 1; }
export LIBGUESTFS_BACKEND=direct
virt-builder "$template" --arch x86_64 --format qcow2 --size 12G --memsize 4096 \
  --output "$output" --upload "$script_dir/agent.py:/root/agent.py" \
  --upload "$script_dir/provision.sh:/root/wret-provision.sh" \
  --run-command 'cd /root && sh /root/wret-provision.sh'
sha256sum "$output" | cut -d ' ' -f 1 > "$(dirname "$output")/guest.sha256"
echo 'Keep this image and checksum together. Copy them to the Windows .wret-vm directory.'
