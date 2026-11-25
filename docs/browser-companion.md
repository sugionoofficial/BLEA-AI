# BLEA Browser Companion (preview)

Browser-only foundation for user-directed, visible actions. The unpacked Chrome/Edge extension runs locally in a side panel and selects a target tab. BLEA Agent can use the extension bridge to ask the configured model for one structured action at a time, observe the result, and plan the next step. It does not control desktop applications or use screenshots/vision.

## AI browser task

Open BLEA at `https://blea.ai` (or localhost for development) and keep that tab open. Open the extension side panel and grant exact origin permissions for the sites the task may visit (for example, `https://www.google.com`) using **Izinkan**. You no longer select a destination tab: when a Browser live task starts, the extension creates and activates a dedicated Google task tab. Then describe the task and consent to sharing page text/controls with the selected model. The model plans one JSON action per request; the extension executes allowlisted actions and returns a fresh snapshot. It re-activates the task tab before observation and action so the browser window follows the task. Tasks stop after 8 model steps. Each planning step may incur the configured `agent_turn` charge.

Normal mode asks for confirmation before each action. Include `lakukan tanpa konfirmasi` in the instruction to opt into automatic actions for that task. Send/submit and other risky actions still require confirmation, and payment/deletion actions are blocked. **STOP** aborts further planning and actions (a browser click already dispatched cannot be undone). **Lanjutkan** asks the model for the next action and requires confirmation before executing it. The task state exists only in the open BLEA page and is not persisted across reloads.

The side panel also has a separate manual command runner. Enter one supported command per line; normal mode confirms each step, while its first-line `lakukan tanpa konfirmasi` opts into automatic execution for that command list.

## Supported commands

- `cari <query> di Google` — opens a Google results tab.
- `buka https://example.com` — navigates the active tab to an explicit HTTP(S) URL.
- `baca halaman` — reads visible page text into the extension popup (up to 7,000 characters).
- `klik tombol "Masuk"` — requires a second confirmation and exact visible button-label match. This may submit a form or send a message, so verify the page and button before confirming.
- `isi kolom "Email" dengan "user@example.com"` — requires a second confirmation, exact visible accessible-name match, and never submits the form.
- `salin teks "draft"` — copies the explicit text to the system clipboard.
- `tempel ke kolom "Pesan"` — after a second confirmation, reads clipboard text and fills the exact matching visible field. Clipboard content is sensitive; use only when you intend to paste it.

Password and hidden inputs are excluded. Payment, purchase, transfer, checkout, refund, deletion, and removal button labels are blocked. Other button clicks—including send/submit—are permitted only after an explicit confirmation. Unknown commands are rejected rather than guessed.

## Install locally

1. Open `chrome://extensions` (or `edge://extensions`) and enable **Developer mode**.
2. Choose **Load unpacked** and select this `browser-agent-extension/` directory.
3. Pin the extension. Open a normal web page and click the extension icon to open its side panel. Enter one supported command per line and review confirmation prompts. For an opted-in task, put `lakukan tanpa konfirmasi` on the first line, then list the steps.
4. Remove the unpacked extension from the extensions page to uninstall it.

The extension requests `activeTab`, `scripting`, `tabs`, `sidePanel`, `storage`, clipboard read/write, and Chrome `debugger` permissions. Debugger is used to activate visible pointer clicks and per-character text input through the DevTools Protocol; Chrome will show its prominent debugging-access warning. The extension declares optional HTTP(S) host permissions; the user must authorize exact site origins with **Izinkan** in the extension side panel. It does not have unconditional host-wide access, storage, network, or BLEA session permissions. Clipboard access is used only for the explicit copy/paste commands; clipboard contents are not sent to BLEA. It does not read the browser's cookies or send page contents to BLEA. The active tab can still contain private information, so do not run `baca halaman` on sensitive pages.

## Reference review

Architecture references reviewed: [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) for a visible agent-owned task window and hold/resume; [Chrome Debug Bridge](https://github.com/darrinm/chrome-debug-bridge) for tab-scoped DevTools Protocol input and screenshots; [Stellar](https://github.com/RohitMunnuru9/stellarextension) for visual browser-agent architecture and permission disclosure. These are design references only: BLEA does not vendor or execute their code. Debugger-based trusted input is powerful and visibly warns the user; websites may still detect automation. In particular, the reference's broad browser access is not copied: BLEA should keep narrow per-task tab access, explicit user initiation, and policy checks before every mutation.

## Deliberate limitations / next work

The BLEA Agent integration uses `browserMode` on `/api/agent`; the server supplies a constrained single-action JSON prompt and exposes no agent tools in that mode. The browser page bridge is only injected on `https://blea.ai` and localhost. Users must keep the BLEA Agent tab open and reload it after installing/updating the extension. Tasks open their own active Google tab rather than borrowing a user-selected tab. Each site origin still requires an explicit grant in the extension side panel; if navigation reaches an ungranted origin, the task pauses with an error until the user authorizes it. Debugger access is powerful and may be disabled by browser policy; it is not hidden or used to bypass site security.

The planner sends bounded page text and visible controls to the chosen BLEA model; the task UI requires explicit consent first. Each planner step is a separate agent request and may incur `agent_turn` credits; the UI displays credits reported by the Worker. Tasks are capped at 8 steps. Browser actions use DOM-backed controls, not screenshots or vision; pages that require trusted physical input, CAPTCHA, OTP, or other human verification can fail and should be completed manually. STOP aborts the next model/action step but cannot undo a click already dispatched. Search/page content is untrusted input and must never be treated as system instructions. No generic page script/eval is exposed.

Run parser tests with `node --test tests/browser-agent-commands.test.js`.
