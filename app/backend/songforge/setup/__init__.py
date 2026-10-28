"""First-run setup: detect the machine, then install only what is agreed to.

Everything under this package is **standard library only** and must stay that
way. It runs before anything is installed - before FastAPI, before PyTorch,
before the virtual environments exist - so it cannot import the rest of
SongForge, and ``songforge/__init__.py`` is empty precisely so that importing
``songforge.setup`` pulls in nothing else.

The split is deliberate:

``hardware``   what this machine is, and what that implies for PyTorch and for
               the generation settings.
``components`` the list of installable things, each able to say whether it is
               already present and how to install itself.
``menu``       the text interface: show the list, take the choices, install.
``cli``        argument parsing and the entry point.
"""
