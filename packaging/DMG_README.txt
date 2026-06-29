Frontctl Setup
==============

Frontctl lets Claude, ChatGPT, or Codex work with your local Front desktop app.
It uses your signed-in Front app on this Mac. It does not use the public Front API.
It never sends email.

Install
-------

1. Double-click Install Frontctl for This User.command.
2. Ask your agent to run: frontctl setup complete --yes --json
3. Approve Touch ID or your password once if macOS asks.
4. Copy the agent prompt printed by setup into Claude, ChatGPT, or Codex.

Frontctl Setup.app is included as an optional support wrapper if you do not want to use Terminal.

The user installer does not need an administrator password. The package installer is included for
admins, managed Macs, and Homebrew-style system installs.

If Something Is Missing
-----------------------

- If Front is not installed, install Front for macOS and sign in.
- If frontctl is not installed, run Install Frontctl for This User.command.
- If live mode is locked, run the setup command again. macOS may ask once for Touch ID or your password.
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
frontctl ready --json
