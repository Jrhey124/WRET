# Companion retirement

Whidra now runs as a static browser application. The companion, QEMU guest, live debugger, bridge instrumentation, request replay, and VM setup scripts have been removed. Use [static deployment](DEPLOYMENT.md); no KVM, QEMU, guest image, SSH tunnel, or companion setup is required.

Historical sessions, requests, bridge observations, snapshots, breakpoint records, and provenance from existing projects remain importable and exportable. Review requests in Network, records in Saved observations, and retained snapshots in Research. These records cannot start execution or reconnect to their old sessions.

If an earlier companion is still running, stop that process before retiring its installation. For a previously installed Linux user service, run:

~~~sh
systemctl --user disable --now whidra-companion.service
~~~

Remove the old user service unit if present. Existing .wret-vm image/session artifacts are not deleted automatically; they are no longer used by Whidra. Export any project you need before changing browser origins.
