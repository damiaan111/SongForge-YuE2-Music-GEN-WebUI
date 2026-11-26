# Security

SongForge is a local application: it runs on your computer, for you. This page
says what it protects, what it deliberately does not, and how to report a
problem.

## The short version

- **Nothing leaves your computer.** There are no accounts, no analytics and no
  telemetry. The only connections SongForge makes are the downloads you approve
  during setup (PyPI, npm, Hugging Face and, if you choose it, Ollama).
- **By default only your own computer can open it.** The web app listens on
  `127.0.0.1`. Other devices can reach it only if you start it with `-Lan`
  (`--lan`).
- **There is no login.** Anyone who can reach the port can use the app: play,
  create, delete, change settings. That is fine on your own machine and on a
  home network you trust. It is not fine on the internet.

**Never port-forward SongForge, put it behind a tunnel, or run it on a network
you do not control.** It is not built to be exposed, and no setting makes it so.

## What is protected

| Risk | What SongForge does |
| --- | --- |
| A website you visit quietly talking to SongForge through your browser | Requests that change anything are refused unless they come from the app's own pages. Requests that arrive under a hostname other than `localhost`, an IP address, or one you listed are refused outright, which stops DNS-rebinding attacks. See `app/backend/songforge/security.py`. |
| Another site showing SongForge inside a frame to trick a click | The app refuses to be framed. |
| Someone on your network (with `-Lan`) pointing SongForge at a different program or model | While SongForge is shared, the settings that decide which program runs and which model it loads cannot be changed at all - only on the computer itself, started without `-Lan`. Beneath that, the engine setting accepts only the `yue2` command or a Python interpreter on a local disk, the command template accepts only `yue2`'s own subcommands and flags, and file-taking flags accept only the paths SongForge supplies. Arguments are passed as a list; no shell is involved. |
| A crafted file name or project id reaching outside the library | Every path is resolved and checked to be inside the project folder before it is opened. |
| The API being reachable from the network | It binds to `127.0.0.1` and is only reached through the web app's proxy. |
| The lyrics writer being pointed at another machine | The Ollama address is fixed in the environment and must be a loopback address; it cannot be changed from the app. |
| Tampered or truncated model files | Setup downloads the model at one exact, recorded revision, checks the weights against their published sizes, and YuE2 verifies their checksums before every render. |
| The model's inference code being replaced upstream | That package is the one download setup executes rather than reads. It is fetched at a recorded revision and installed only if its SHA-256 matches the one in `app/backend/songforge/setup/components.py`; there is no override for that check. |
| A dependency changing under you | The backend installs pinned versions, the web app installs from its lockfile, and CI reports known advisories. PyTorch wheels are checked against the checksum their index publishes. |

## What is not protected

- **Other people on a network you shared it with.** With `-Lan`, everyone on
  that network has full use of the app, including deleting your songs. Share it
  only on a network where that is acceptable.
- **Other users of the same computer.** Your songs are ordinary files in
  `runtime/projects`, readable by anyone who can read your files.
- **What the Settings page shows.** It displays the folders SongForge uses,
  which include your user name if it is installed under your home folder. With
  `-Lan`, people on your network can see that page.
- **The upstream projects themselves.** Pinning proves you got the files that
  were tested; it does not audit them. PyPI and npm packages, PyTorch, the
  YuE2 model and Ollama are trusted as published.
- **Generated content.** What the model produces is your responsibility, as is
  the licence it is under - see [NOTICE.md](NOTICE.md).

## What setup and the launchers do to your system

Everything SongForge installs goes into the `runtime/` folder inside its own
directory. Deleting that folder removes it.

- `setup.bat` and `start.bat` run PowerShell with the execution policy relaxed
  **for that one process**. The system-wide policy is not changed.
- Nothing is registered to start with your computer, no service is installed
  and no firewall rule is created. `scripts/Install-StartupTask.ps1` and
  `scripts/Create-DesktopShortcut.ps1` exist for people who want those; they
  do nothing unless you run them.
- Setup installs software from outside this repository only when you tick it,
  and for Ollama and FFmpeg only through a package manager you already have
  (`winget`, Homebrew) and only after asking.
- Setup and the launchers never ask for administrator rights. If one does,
  stop. The only administrator step anywhere in the documentation is the
  optional Windows firewall rule for sharing on your network, which you type
  yourself.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Use GitHub's private reporting instead: on the repository page, **Security →
Report a vulnerability**. Include what you did, what happened, and the output of

```
python app/backend/songforge/setup/__main__.py --detect
```

with anything you consider private removed. You will get a reply there.

Only the latest version on the `main` branch is supported; fixes are not
back-ported.
