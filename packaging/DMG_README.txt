Frontctl Setup
==============

Frontctl lets Claude, ChatGPT, or Codex work with your local Front desktop app.
It uses your signed-in Front app on this Mac. It does not use the public Front API.
It never sends email.

Install
-------

1. Double-click frontctl-<version>.pkg and finish the installer.
2. Open Frontctl Setup.app from this disk image.
3. Click Check Setup.
4. Click Install Agent Skills.
5. Click Enable Live Mode.
6. Copy the short agent prompt into Claude or Codex, or click Copy ChatGPT Instructions for ChatGPT.

If Something Is Missing
-----------------------

- If Front is not installed, install Front for macOS and sign in.
- If frontctl is not installed, run the package installer in this disk image.
- If live mode is locked, click Enable Live Mode. macOS may ask once for Touch ID or your password.
- If you need help, click Support Bundle. It writes a redacted frontctl-support.json file to your Desktop.

Uninstall
---------

Double-click Uninstall Frontctl.command. It removes frontctl local data, installed agent skills,
and package-installed CLI files. Front for macOS and your Front account are not modified.

Privacy
-------

The support bundle does not include cookie values, auth headers, mailbox body text, email subjects,
or signed attachment URLs.

Terminal Check
--------------

frontctl --version
frontctl doctor --json
frontctl readiness --json
