# Astraeya tools: file creation, document reading, logos

What Astraeya can now do in a conversation beyond writing text, how each piece
works, what it costs, and what is still to be built.

## What a user sees

| They ask | They get |
|---|---|
| "Draft a cover letter and give me a PDF" | A download card under the reply with the finished, letterheaded PDF |
| "Make a 10-slide presentation on…" | A `.pptx` card |
| "Turn this data into a chart and an Excel file" (CSV/XLSX attached) | A `.xlsx` card and a `.png` chart card (shown as a picture) |
| "Convert this Word document to PDF" (DOCX attached) | A `.pdf` card |
| "Crop this / make it black and white" (photo attached) | The edited image |
| "Make the title blue" after a file | A revised file, made in the same sandbox |
| A scanned PDF, photo of notes or exam paper + "what does this say?" | The transcribed text, tables and page order kept |
| "Make me a logo for Wezitech" | The logo drawn on screen, with **SVG** and **PNG** download buttons; "make it white" redraws it |

While a file is being made, the reply shows "Getting ready…", "Reading your
files…" or "Creating your file…" instead of the typing dots.

## How it works

### Tool layer

Astraeya uses the model provider's server-side tools, declared per request.
New tools are added in `astraeya-api/src/ai/providers/anthropic.provider.ts`
without any retraining:

| Tool | Provider type | When it is switched on |
|---|---|---|
| Web search | `web_search_20250305` | Account has web search on |
| Web fetch | `web_fetch_20250910` | With web search |
| Code sandbox + document skills (`docx`, `pptx`, `xlsx`, `pdf`) | `code_execution_20260521` + `container.skills` | The message asks for a file (`src/ai/file-intent.ts`), or changes a file the previous reply made |

The sandbox only opens when a message needs it, because it adds seconds and
cost. The decision is made in `wantsFileOutput` / `wantsFileEdit`, which are
covered by unit tests, including the acceptance-test phrasings.

### File creation (Priority 1) and code execution (Priority 4)

1. The chat route (`src/routes/chat.routes.ts`) decides whether to open the
   sandbox. It needs the `fileCreation` feature flag on, the hosted provider,
   no "process locally only" privacy setting, and the user under their daily
   `filesPerDay` limit (default 30, set in the admin panel).
2. The user's attachments are uploaded into the sandbox, so code can open the
   photo, notes or data.
3. The model writes and runs Python in Anthropic's isolated container. Each
   container is separate, has no network access, and can't see other users'
   data. It runs under the provider's CPU, memory and time limits.
4. Each file the sandbox saves is recorded in `generated_files` (owner,
   conversation, reply, name, type, size) and streamed to the browser as a
   `file` event.
5. The conversation keeps its sandbox id (`conversations.sandbox_id`), so a
   follow-up edits the same file. An expired sandbox is retried without the id.

### Download links

- `GET /files/:id/download?token=…` streams the file. The token is a JWT
  signed with the server secret. Its audience (`astraeya-file-download`) is
  separate from login tokens, it names the file and its owner, and it expires
  after **1 hour**. The owner check runs again against the database on every
  download.
- Links never expose the provider's file id or storage location.
- Signed links (not session auth) mean a phone's browser or download manager
  can open them. Reloading the chat issues fresh links. An expired card calls
  `GET /files/:id/link` for a new one.
- `DELETE /files/:id` removes a file here and in the provider's store.
- Erasing data or deleting the account removes all of a user's files from the
  provider's store too (`purgeUserFiles`).

### Document reading and OCR (Priority 2)

`src/services/documents.service.ts` extracts text from each attachment once,
when it arrives, and stores it with the message, so follow-up questions and
local models can use it.

- PDFs with a text layer are read directly.
- A PDF with fewer than 40 characters per page is treated as scanned and
  read visually by the vision model (`src/ai/visual-reader.ts`). Headings,
  tables (as Markdown), handwriting (`[illegible]` where unreadable) and page
  markers are kept.
- Long scans are split into 20-page ranges with `pdf-lib`, read four at a
  time, and joined in page order, up to 600 pages.
- Photos (notes, exam papers) go to the vision model directly.
- Up to 1,000,000 characters (about 250k tokens) are kept per document. After
  the first turn the document comes from the prompt cache.

### Logos and illustrations (Priority 3, partial)

There is no image-generation model yet. Logos, icons and simple
illustrations are drawn as SVG in the reply. The web chat shows the drawing as
an `<img>`, so a hostile SVG cannot run scripts, and offers SVG and PNG
downloads. The PNG is rendered in the browser at 2048 px, so it costs no
server time. This also covers the spec's fallback: when an image can't be
made, the user still gets SVG code with an explanation.

### Telling the model what it can do

The system prompt (`SYSTEM_PROMPT_BASE` in `src/services/prompt.service.ts`)
now lists what Astraeya can and cannot do: no email, no calendar, no
photographic images. Every turn also carries a note saying whether file
creation is available, so the model never claims a file it can't make. When
it isn't available, the model says so and gives the content in the chat,
where the existing Word/Markdown export button applies.

## Security and data protection

- Uploads are validated by type (admin allow-list) and size (50 MB per
  document, 5 MB per image) before anything else happens.
- All code runs in the provider's sandbox, never on Astraeya's servers.
- File names are cleaned before storage and before being sent in headers.
- Downloads are `Cache-Control: private, no-store` and `nosniff`. Only images
  and PDFs may open inline.
- Accounts set to "process locally only" never have documents read visually or
  files made, because both send data to the hosted provider.
- **Uganda Data Protection and Privacy Act 2019:** files and documents are
  personal data processed by a third-party processor (Anthropic) outside
  Uganda. What exists: per-user ownership, deletion on request, erasure on
  account deletion, and opting out through local-only mode. Still needed: say
  this in the privacy notice, and record it in the PDPO registration and
  processor agreement.
- **Not yet done:** malware scanning of uploads. Uploads are only parsed (by
  pdf-lib, mammoth, JSZip) or forwarded to the provider, never executed, but
  a scanner (ClamAV as a sidecar) should be added before public launch.

## Cost per tool (estimates, November 2026 list prices, USD)

Standard model: Sonnet 5.5 at $2 per million input tokens, $10 per million
output tokens, and $0.10 per million cached reads.

| Tool | What drives cost | Typical cost per use |
|---|---|---|
| Cover letter as PDF | ~15k input incl. skill instructions, ~4k output, sandbox minutes | **$0.05–0.10** |
| 10-slide deck | Measured: ~400k cache-write + ~1.3M cache-read input over many sandbox rounds, ~11k output | **≈ $1.25** (measured 2026-11-15) |
| Chart + Excel from a CSV | ~20k input, ~6k output | **$0.06–0.15** |
| Sandbox compute | 1,550 free container-hours per month per organisation, then $0.05/hour (5-minute minimum) | ≈ $0 until ~18,000 file requests/month, then ≈ $0.004 each |
| Scanned PDF (OCR) | ~1,600 input tokens per page image + ~500 output tokens per page | **≈ $0.008 per page** (200 pages ≈ $1.60, once) |
| Text PDF, follow-up questions | Document read from cache | 200 pages ≈ 120k tokens ≈ $0.24 first turn, ≈ $0.012 each later turn |
| Logo (SVG + PNG) | One reply, ~2–4k output tokens. PNG rendered in the browser | **$0.02–0.05** |
| File storage | Kept in the provider's file store; no Astraeya storage bill | $0 (provider storage limits apply) |
| True image generation (not built) | Depends on the provider chosen | ~$0.02–0.08 per image |

The daily `filesPerDay` limit (default 30) caps the worst case at about
$38/user/day if every request is a deck. Lower it for free accounts (5 ≈ $6/day).
The deck cost is driven by the skill instructions and file reads being
re-sent each sandbox round; see `docs/TOOLS-TEST-REPORT.md`.

## Phased plan

| Phase | Scope | Status |
|---|---|---|
| **1** | File creation and export: docx/pdf/pptx/xlsx/csv/md, conversion, branding, signed expiring links, per-user quota, mobile-friendly downloads | **Done (web).** Mobile app shows no file cards yet (it gets `files` in the JSON reply) |
| **2** | OCR: scanned PDFs, photos, handwriting, long documents, tables and page order kept | **Done** |
| **3** | Image generation | SVG logos with SVG/PNG export and edits **done**. Photographic or painted images need an image-generation provider: an account decision (OpenAI gpt-image, Google Imagen, or similar). The `imageGeneration` flag and `imageGenerationsPerDay` limit are already in the platform config |
| **4** | Code execution | Done through the same sandbox for data, charts, spreadsheets and conversion. A general "run this Python" mode outside file requests is a small change to `file-intent.ts` |
| **5** | Gmail / Outlook drafts with approval before send | **Not started.** Needs Google and Microsoft OAuth apps registered under Wezitech. Then: token storage per user, a `create_draft` tool, and an approval card in the chat. Nothing is sent without a click |
| **6** | Quality of life | Memory, projects, conversation recall, cited search and voice already exist. Still to do: low-bandwidth mode, file cards in the mobile app, and a "My files" section in the Library (API ready: `GET /files`) |

## Test report

See `docs/TOOLS-TEST-REPORT.md`.
