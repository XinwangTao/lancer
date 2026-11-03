# Extra capture roots

Lancer captures every turn's file changes from the workspace checkout. Some useful
work happens outside that checkout: a knowledge base, a shared notes folder, or a
configuration repository. Extra capture roots bring those changes into the same turn
view without turning them into workspaces.

## Configure

Add roots in the user data directory as `extra-capture-roots.json`:

```json
{
  "roots": [{ "path": "D:\\Notes\\Vault", "label": "Vault" }, { "path": "C:\\Users\\me\\dotfiles" }]
}
```

- `label` is shown in the turn-changes card and the GitTree commit points. It
  defaults to the folder name.
- Plain strings are accepted and use the folder name.
- `LANCER_EXTRA_CAPTURE_ROOTS` overrides the file: a semicolon-separated list of
  absolute paths. Labels default to folder names.

The file is read once at startup; restart Lancer after editing it.

## Requirements and behavior

- Each root must be the top level of a Git checkout. Lancer uses Git only to
  inventory files; it never stages, commits, or writes to the root's index.
- Captures are stored in an app-owned bare repository under the user data
  directory (`turn-checkpoints-external-<n>`), next to the workspace captures.
- A turn's card lists external files after workspace files. External rows carry
  the configured label and do not open the workspace diff view.
- Every external file also becomes a `提交/保存` point in the GitTree, anchored
  after the turn's last transcript entry.
- If a root is missing, not a Git checkout, or exceeds the capture limits, its
  changes are skipped for that turn; the workspace card is unaffected.

## Limits

External roots use larger defaults than a code checkout because knowledge bases
tend to be bigger:

| Limit            | Value   |
| ---------------- | ------- |
| Capture timeout  | 10 s    |
| Files            | 20,000  |
| Total bytes read | 768 MiB |
| Single file      | 64 MiB  |

The first capture reads every file. Later captures only read files whose size or
timestamps changed, so steady-state cost follows the size of the edit, not the
size of the root.
