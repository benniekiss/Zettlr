---
workspace: THIS IS A TEST WORKSPACE
---

# Zettlr Workspace Testing Environment

> workspace assets must first be enabled under the `Advanced` settings pane.

This is a testing environment for Zettlr workspaces. This folder includes a `.zettlr`
directory containing various assets which can be loaded *for each* open workspace. Assets
can only be used if the currently focused file is part of the same workspace.

The following assets can be loaded:

- Snippets
- Export profiles and lua filters
- User dictionaries
- Custom CSS

In this workspace, snippets, export profiles, dictionaries, and CSS are all included.

The files in the `.zettlr` folder can be edited in the regular editor, and changes will
be applied on file save.

---

The following is to test workspace lua filters. The variable below should be replaced
with the content of the same variable in the yaml frontmatter:

%workspace%
