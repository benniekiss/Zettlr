# Language servers

Zettlr uses the official [CodeMirror LSP client](https://github.com/codemirror/lsp-client).
Configure installed language servers in **Preferences → Language servers**.
The configuration is a JSON array; valid edits apply when the field loses focus.
An empty array disables language servers. Zettlr does not download or install servers.

For example, after installing [panache](https://github.com/jolars/panache),
[codebook](https://github.com/blopker/codebook), and
[LTeX+](https://ltex-plus.github.io/ltex-plus/installation-usage.html):

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

Each editor view has its own server processes and client workspace. Settings
changes restart its servers; closing the view or window stops them. A failed
server does not disable other servers. Startup failures are reported to the
console and application log. To retry a stopped server, reopen the document or
change its configuration.

This initial integration supports stdio and open-document editing. Cross-file
navigation/edits, filesystem watches, server code actions, and server-specific
commands (including dictionary/ignore-rule actions) are not implemented yet.
Legacy Hunspell dictionaries, LanguageTool HTTP settings, and remark lint settings
are not converted automatically. Configure replacements through each server's
settings or configuration files; existing dictionary files are not deleted.
