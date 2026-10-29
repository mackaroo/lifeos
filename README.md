# lifeOS

A small personal app (installable PWA) for to-dos, notes, spending and a daily log.

- Hosted on GitHub Pages: https://mackaroo.github.io/lifeos/
- **No personal data lives in this repo.** All data is one JSON file (`lifeos.json`) in the owner's own Google Drive, read and written through Google Sign-In and the Drive API (`drive.file` scope: the app can only see files it created).
- A copy is cached in the browser so the app opens instantly and works offline; changes sync when back online.

## Quick add

Type in the top bar and press Enter (press `/` to jump there):

| Type | Result |
| --- | --- |
| `Call dentist tomorrow 3pm #health` | To-do in Health, due tomorrow at 3pm |
| `Pay bill fri` | To-do due this Friday |
| `n: weekend market idea` | Note |
| `$12.50 Target #collecting` | Spending entry |

## Data format

`lifeos.json` is plain, readable JSON so it can be edited by hand (or by Claude through Google Drive):

```json
{
  "categories": { "Home": "#ffb3c7" },
  "todos":    [{ "id": "…", "text": "…", "category": "Home", "done": false, "due": "2026-11-02", "time": "", "added": "2026-10-29" }],
  "notes":    [{ "id": "…", "type": "note | idea | quote", "text": "…", "who": "", "source": "", "added": "…" }],
  "spending": [{ "id": "…", "date": "…", "amount": 12.5, "store": "…", "category": "…", "kind": "needed | impulse", "note": "", "returnBy": "" }],
  "wishlist": [{ "id": "…", "item": "…", "price": 9.99, "category": "…", "status": "want", "added": "…" }],
  "log":      [{ "date": "2026-10-28", "mood": 4.5, "energy": 4, "highlight": "…" }]
}
```

New items go at the top of each list. Give new items a unique `id`.

## Run locally

```bash
python -m http.server 8000
```

Then open http://localhost:8000.
