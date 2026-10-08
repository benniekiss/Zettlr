# Language servers

Zettlr uses the official [CodeMirror LSP client](https://github.com/codemirror/lsp-client).
Configure language servers in **Preferences → Language servers**.
The configuration is a JSON array; valid edits apply when the field loses focus.
An empty array disables language servers. Use **Add panache, codebook, and LTeX+**
to add the configurations below while preserving existing entries.

Official builds bundle [panache](https://github.com/jolars/panache),
[codebook](https://github.com/blopker/codebook), and
[LTeX+](https://ltex-plus.github.io/ltex-plus/installation-usage.html), including
LTeX+'s Java runtime. **Use bundled language servers** defaults to enabled:
the bare commands `panache`, `codebook-lsp`, and `ltex-ls-plus` select the bundled
versions when available. Explicit executable paths always select that installation.
Disable this option to use system installations for all servers. If a build omits
a server, its configured command is used instead. Changing the option restarts
active servers immediately. Zettlr does not download servers at runtime.

For example:

```json
[
  {
    "name": "panache",
    "command": "panache",
    "args": ["lsp"],
    "languages": ["markdown"]
  },
  {
    "name": "codebook",
    "command": "codebook-lsp",
    "args": ["serve"],
    "languages": ["markdown"]
  },
  {
    "name": "ltex",
    "command": "ltex-ls-plus",
    "languages": ["markdown", "latex"],
    "settings": {
      "ltex": {
        "language": "en-US"
      }
    }
  }
]
```

Use an absolute executable path if a server is not on Zettlr's PATH. Arguments are
individual JSON strings. Commands run without a shell, so shell expansion and
pipes are not supported. On Windows, use native executables or explicitly invoke
an interpreter for script-based launchers.

Each server accepts these fields:

| Field | Meaning |
| --- | --- |
| `name` | Required unique name. |
| `command` | Required executable name or path. |
| `languages` | Required nonempty list of language IDs: `markdown`, `latex`, `yaml`, or `json`. |
| `args` | Optional array of command arguments. |
| `enabled` | Set to `false` to disable this server. Defaults to `true`. |
| `cwd` | Working directory and workspace root. Defaults to the document's directory. |
| `env` | Additional environment variables; values must be strings. |
| `initializationOptions` | Object sent with the LSP `initialize` request. |
| `settings` | Object sent through `workspace/didChangeConfiguration` and returned for `workspace/configuration` requests. Use nested objects for section names. |

Diagnostics from all matching servers appear together in the editor and lint panel.
Interactive requests use the first matching server that advertises the feature;
place the preferred formatter/completion provider first. The client enables
completion, hover, signature help, formatting (Shift-Alt-F), rename (F2),
definition (F12), and references (Shift-F12), subject to server capabilities.
YAML validation remains available locally.

Load spelling fixes and other diagnostic code actions with the native
**Show fixes** button: hover over an underlined diagnostic, or open the diagnostics
panel by clicking the diagnostic counts in the status bar. **Ctrl-Shift-M** (Windows/Linux)
or **Cmd-Shift-M** (macOS) also opens and focuses the panel. Choose **Show fixes**
for a diagnostic to load its actions in the panel. Its action buttons have underlined keyboard shortcuts. Actions are fetched on demand and
cached in a bounded cache.

Codebook's buttons include spelling suggestions, **Add to dictionary**, **Add to
global dictionary**, and ignoring the current file. Commands run on the server
that supplied the diagnostic, even with several servers configured. Dictionary
locations and persistence are controlled by codebook. Text fixes support undo.
Actions disappear after editing until fresh diagnostics arrive; stale fixes are
never applied to changed text. Edits to unopened files and file creation,
renaming, or deletion are rejected without applying part of the edit.

Each editor view has its own server processes and client workspace. Settings
changes restart its servers; closing the view or window stops them. A failed
server does not disable other servers. Startup failures are reported to the
console and application log. To retry a stopped server, reopen the document or
change its configuration.

This initial integration supports stdio and open-document editing. Cross-file
navigation/edits and filesystem watches are not implemented yet. Only commands
returned by diagnostic code actions are exposed; server-specific client commands
(such as LTeX+ dictionary management commands) are not implemented.
Legacy Hunspell dictionaries, LanguageTool HTTP settings, and remark lint settings
are not converted automatically. Configure replacements through each server's
settings or configuration files; existing dictionary files are not deleted.

## Building with language servers

Forge downloads and bundles pinned, checksummed distributions for the target
platform and architecture. Set `BUNDLE_LSP=0` to disable all three, or use
`BUNDLE_PANACHE=0`, `BUNDLE_CODEBOOK=0`, and `BUNDLE_LTEX_PLUS=0` individually.
Disabling Pandoc bundling does not affect language servers.

For development, run `node scripts/get-language-servers.js` to prepare bundles
for the current machine, or pass a target such as `linux arm64`. The editor can
use these bundles from `resources/lsp/<platform>-<arch>/language-servers`.
Versions, release URLs, and SHA-256 checksums are pinned in
[`scripts/lsp-servers.json`](../scripts/lsp-servers.json). Cached downloads are
verified before extraction; updating this manifest updates the next build.
Complete distributions, including licenses, are packaged outside the ASAR archive.
