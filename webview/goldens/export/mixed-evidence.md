# Report · 2026-09-18 12:00 UTC

- Claude Code 2.1.246
- 3 sessions since 2026-09-11 12:00 UTC
- Run usage: 1,000 prompt tokens · 100 output tokens · 0.0040 USD (estimated by Claude Code)

## 1\. Lead line 0 for re-read-loop

*Re-read loop · low confidence · since last run: new*

**Cause**

Cause sentence 0.

**Evidence**

- Reads: **7** `sessions[0].loops[0].count · ses_example01`
- File: **repo/docs/schema.md** `sessions[0].files[2].filePath · ses_example01`
- Skill: **phase** `sessions[1].skills[0].name · ses_example02`
- Cache ratio: **0.11** `sessions[1].totals.prompt · ses_example02`
- Longest gap: **28,100,113 ms · 7 h 48 m** `sessions[0].timing.longestGapMs · ses_example01`
- Gap before spike: **312,450 ms · 5 m 12 s** `sessions[1].contextChurn[0].gapBeforeMs · ses_example02`
- Duration sum: **90,500 ms · 1 m 30 s** `sessions[1].tools[0].durationMsSum · ses_example02`
- Duration max: **61,250 ms · 1 m 1 s** `sessions[1].tools[0].durationMsMax · ses_example02`
- Cost: **0.24** (exact 0.238149) `sessions[0].totals.costUsd · ses_example01`
- Cost per hour: **0.37** (exact 0.37125) `sessions[0].timing.costPerHourUsd · ses_example01`
- Cache ratio: **0.82** (exact 0.8234567) `sessions[0].agents[0].cacheRatio · ses_example01`
- Context fill: **0.40** (exact 0.4) `sessions[0].totals.contextFill · ses_example01`
- Tokens per minute: **1,235** (exact 1234.5678) `sessions[0].timing.tokensPerMin · ses_example01`
- Calls per minute: **3** `sessions[0].timing.callsPerMin · ses_example01`

No longer reported: Stall, Cache miss
