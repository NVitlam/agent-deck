# `webview/goldens/drawer`

| file | what produced it | what it pins | read by |
|---|---|---|---|
| `follow.json` | hand-written from the user's rule (2026-09-05, v0.7.0 DoD 4.9b) | `webview/drawer.ts:followTarget` and `atGrowingEnd` — the drawer's follow-the-latest scroll target | `webview/drawer.test.ts` |

**This golden is NOT a second implementation.** Nothing computed it but a
person reading the rule: follow the latest call in whichever direction the
list grows; an expanded entry pins; closing it resumes. What it buys is the
same thing `../layout/lane-subsets.json` buys — the answers are written down
outside the code that produces them, so a change to the rule has to move a
committed number. Do not describe it as two implementations agreeing.

`webview/inspector.phase4.test.ts` drives the component the function serves.
