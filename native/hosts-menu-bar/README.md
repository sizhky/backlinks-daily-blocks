# Hosts Menu Bar

A macOS menu bar app that controls valid IP mappings after the first `----` line in `/etc/hosts`.

## Build and run

Run `sh build-app.sh --replace`, then open `dist/Hosts Menu Bar.app`.
Choose **Set up password-free locking** once; macOS asks for administrator authorization to install the helper.
After setup, **Lock hosts block** activates mappings without a password; **Unlock hosts block** requests authorization.
The open-lock icon means mappings are commented; the closed-lock icon means mappings are active.

The root helper accepts only a fixed lock request and changes only valid mappings below the separator.
It preserves other lines and exposes no unlock operation over XPC.
Use **Remove password-free lock helper** to uninstall the system helper with administrator authorization.
