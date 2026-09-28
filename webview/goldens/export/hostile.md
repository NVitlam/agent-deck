# Report · 2026-09-21 12:00 UTC

- Claude Code 2.1.246
- 1 session since 2026-09-20 12:00 UTC

## 1\. \<img src="https://example.invalid/t.png"\> \!\[x\](https://example.invalid/i.png)

*Churn chain · medium confidence · since last run: still*

**Detail**

\<script src="https://example.invalid/s.js"\>\</script\>\
\[link\](https://example.invalid/)\
\`\`\`\
code\
\`\`\`

**Cause**

\<iframe src="https://example.invalid/f"\>\</iframe\> \<link rel="stylesheet" href="https://example.invalid/c.css"\> \| cell \| \*em\* \_em\_ \~\~s\~\~ \# h \<https://example.invalid/a\>

**Evidence**

- \<b\>label\</b\>: **repo/\<img src=x onerror=y\>.md** `sessions[0].files[0].filePath · ses_example01`
