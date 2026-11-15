# Astraeya tools: acceptance test report

Run on 2026-11-15 against a local API (`claude-sonnet-5-5`, test database on
port 5433), using a fresh registered account per run. Each case sends a real
chat request over the streaming endpoint and, where files are made, downloads
them through the signed `/files/:id/download` link and checks the bytes.

Unit tests: API 151/151 pass, web 40/40 pass. Both projects typecheck cleanly.

## Results

| Case | Request | Result | Time | Output |
|---|---|---|---|---|
| Cover letter | "Draft a cover letter … and give me a PDF. Brand it with a simple letterhead." | **Pass** | 20 s | `Cover_Letter_Amina_Nakato.pdf` (3.3 KB), downloads as a valid PDF |
| Scanned PDF | Image-only PDF + "What does this say?" | **Pass** | 8 s | Questions transcribed with headings and numbering kept |
| Logo | "Make me a logo for Wezitech", then "make it white" | **Pass** | 7 s | SVG drawn inline; follow-up redrew it white on dark blue |
| Chart + Excel | `sales.csv` + "Turn this data into a chart and an Excel file" | **Pass** | 38 s | `Sales_by_Region.xlsx` (7.8 KB) and `Sales_by_Region_Chart.png` (61 KB), both download correctly |
| 10-slide deck | "Make a 10-slide presentation on renewable energy in Uganda" | **Pass** (after fix) | 99 s | `Renewable_Energy_Uganda_10_slides.pptx` (60 KB), 10 slides |
| 200-page PDF | Long PDF + summary and an exact quote from page 137 | **Pass** | 11 s | Answered from the document; no truncation |

Status messages seen by the user: "Getting ready…", "Reading your files…",
"Creating your file…", matching the design.

## Bug found and fixed: deck request ended with nothing

On the first run the deck case failed after 2 seconds with an empty reply.
The model called a tool named `view` (to look at the skill's instructions),
which is not a declared tool. The turn ended with `stop_reason: tool_use` and
the provider treated that as the end of the reply.

Fix (`astraeya-api/src/ai/providers/anthropic.provider.ts`): stray tool calls
are answered with an error result pointing back to `code_execution`, and the
loop continues (bounded by the existing round limit). On the re-run the model
made the same `view` call, received the error, and went on to build the deck.

## Cost finding

The deck is far more expensive than first estimated. Measured usage for one
deck: ~406k cache-write tokens, ~1.32M cache-read tokens, ~11k output tokens,
about **$1.25** at Sonnet 5.5 rates, against an estimate of $0.15–0.35.
`docs/TOOLS.md` has been corrected. Options to bring it down, not yet done:

- Lower `filesPerDay` for free accounts.
- Limit the number of sandbox rounds per request for decks.
- Offer decks to paid plans only.

## Not yet covered

- File cards in the mobile app (it receives `files` but does not show them).
- Tampered and expired download links are rejected in unit tests
  (`src/services/files.test.ts`), but this live run did not try them.
