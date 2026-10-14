# KA Visual Solver

Current version: **v4.12.1**.

A Khan Academy userscript that reads the visible exercise, asks **OpenCode + Big Pickle** for a solution, then displays the result in a small panel. It supports multiple-choice, mixed questions, answer fields, tables, drag-and-drop previews, and image-assisted questions.

> **Important:** This script displays suggested answers. It does not click answer choices or submit Khan Academy exercises for you. AI answers can be wrong; verify them before relying on them.

## Features

- A pinned solver panel on Khan Academy and classroom.khanacademy.org.
- OpenCode's local HTTP server at `http://127.0.0.1:4096` by default.
- Big Pickle selected through OpenCode (model ID: `opencode/big-pickle`).
- Second-pass answer checking.
- Mixed answers for exercises with both choices and fill-in fields.
- Visible question text, answer choices, table structure, SVG/canvas hints, and attachable images in the model prompt.
- Graphical multiple-choice options (including number-line diagrams) are preserved as separate choices, with a labeled visual montage attached for the model to compare.
- Layouts gated by detected page controls, so an AI response alone should not create a pretend graph or grid.
- Graph-like SVGs inside multiple-choice options are treated as option artwork, not as a request to draw a new Cartesian plane.
- Manual solving by default; an optional auto mode can solve newly detected questions.
- Optional second-pass AI verification (can be switched off to get the first answer without a verification request).
- Light and dark panel themes; both theme and double-check preference persist in browser storage.
- Selecting dropdown answers or moving draggable items should not reset the solution panel, because dynamic answer state is excluded from the question fingerprint.
- Multiple-choice detection supports more Perseus/radio-group markup variants.
- Static Graphie/Cartesian diagrams in the question prompt do not by themselves enable the graph-answer preview; the script looks for actual interactive graph-answer controls.
- Dropdown selections and drag/drop placement changes are excluded from question identity so they should not clear an existing solution.
- Broader answer-choice detection for alternate Khan Academy radio-group and choice markup.
- An image or diagram alone cannot trigger a generated graph preview; the question must explicitly ask the learner to graph, plot, draw, or move a point on an actual graph interaction widget.
- Dropdown selections and their current values are excluded from the question fingerprint, helping prevent the result panel from resetting while answering.

## Requirements

- Firefox or another browser supported by a userscript manager.
- [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).
- [OpenCode](https://opencode.ai/) installed and authenticated with a provider that offers Big Pickle.
- An internet connection if the selected OpenCode provider hosts the model remotely. The OpenCode server runs locally, but that does **not** necessarily mean inference is local.

## Install the userscript

1. Install Violentmonkey or Tampermonkey in your browser.
2. Open the [userscript file](./ka-visual-solver.user.js) on GitHub and copy its full contents.
3. Open your userscript manager and choose **Create a new script**.
4. Replace the editor contents with the copied script, then save.
5. Start the OpenCode server using the instructions below.
6. Open an exercise on Khan Academy. The **KA Visual Solver** panel should appear in the lower-left corner.

If the script is updated later, replace the installed script's contents with the latest version from this repository.

## Install OpenCode on Linux

Open a terminal and run the official installer:

```bash
curl -fsSL https://opencode.ai/install | bash
```

Restart your terminal if needed, then verify the installation:

```bash
opencode --version
```

The official install page lists alternatives and platform-specific options: [OpenCode installation docs](https://opencode.ai/docs/).

### Configure Big Pickle

1. Start the OpenCode terminal interface:

   ```bash
   opencode
   ```

2. In OpenCode, run `/connect`, choose **OpenCode** / **OpenCode Zen** as the provider, and follow the sign-in or API-key prompts.
3. Confirm that Big Pickle is available. The model ID used by this script is `opencode/big-pickle`. If it is not available to your account, check OpenCode's model list and provider access.
4. Exit the interactive interface after authentication.

OpenCode's official docs: [providers](https://opencode.ai/docs/providers/), [models](https://opencode.ai/docs/models/), and [OpenCode Zen](https://opencode.ai/docs/zen/).

### Start the local API server

Run this in a terminal and leave it open while using Khan Academy:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

The script defaults to `http://127.0.0.1:4096`. To use another host or port, click **OpenCode settings** in the userscript panel and enter the server URL.

## Install OpenCode on Windows

OpenCode's official documentation recommends WSL for the best compatibility, but native Windows installation is also available.

### Option A: Windows Subsystem for Linux (recommended)

1. Open **PowerShell as Administrator** and run:

   ```powershell
   wsl --install
   ```

2. Restart Windows if prompted, then open the installed Linux distribution (usually Ubuntu).
3. In the Linux terminal, install OpenCode:

   ```bash
   curl -fsSL https://opencode.ai/install | bash
   ```

4. Verify it:

   ```bash
   opencode --version
   ```

5. Start OpenCode with `opencode`, use `/connect` to authenticate with OpenCode / OpenCode Zen, and check that `opencode/big-pickle` is available.
6. Exit the interactive interface, then start the server in the WSL terminal:

   ```bash
   opencode serve --hostname 127.0.0.1 --port 4096
   ```

   Keep this terminal running. WSL usually forwards localhost services to Windows. If the browser cannot connect, check the [official Windows/WSL guide](https://opencode.ai/docs/windows-wsl/).

### Option B: Native Windows

You can install using an official package manager:

- **Scoop** (if already installed): open PowerShell and run `scoop install opencode`.
- **Chocolatey** (if already installed): open PowerShell and run `choco install opencode`.
- **npm** (requires Node.js/npm): run `npm install -g opencode-ai`.

Then open PowerShell or Windows Terminal and verify:

```powershell
opencode --version
```

Start OpenCode, run `/connect`, authenticate with OpenCode / OpenCode Zen, and confirm that `opencode/big-pickle` is available. Exit the interactive UI and launch the server:

```powershell
opencode serve --hostname 127.0.0.1 --port 4096
```

Leave the server terminal open while using Khan Academy.

Official references: [Windows/WSL setup](https://opencode.ai/docs/windows-wsl/) and [installation methods](https://opencode.ai/docs/).

## Solver settings

The controls under **OpenCode settings** include two toggles:

- **Double-check: ON/OFF** — enabled by default. When on, the script sends a second request to Big Pickle to independently review the first answer. Turn it off to skip that request and display the first-pass answer sooner; the answer may be less reliable.
- **Theme: Light/Dark** — switch the solver panel between light and dark appearances. The chosen theme is retained across page loads.

These preferences are saved in the browser's local storage for the Khan Academy site. Clearing site data may reset them.

## Use it

1. Start the server at `127.0.0.1:4096`.
2. Open a Khan Academy exercise.
3. Click **Solve question** for manual mode, then confirm the prompt to send the visible question to OpenCode.
4. Review the displayed answer and explanation. The script runs a second verification pass when possible.
5. To automatically solve newly detected questions, click **Enable auto AI** and confirm the consent prompt.

The script does not fill in or submit answers on Khan Academy. It only displays a suggested solution.

## Troubleshooting

- **Connection refused / could not connect:** make sure `opencode serve --hostname 127.0.0.1 --port 4096` is still running and the userscript URL matches.
- **Big Pickle is unavailable:** authenticate via `/connect` and make sure your OpenCode account/provider can access the `opencode/big-pickle` model.
- **HTTP 401 or 403:** check whether server authentication is enabled and whether the script is configured to use the appropriate server.
- **No question detected:** wait for the exercise to finish loading, then click **Refresh question**.
- **A wrong or incomplete answer:** AI output is not guaranteed. Re-check the question and use Khan Academy's own feedback to verify it.
- **Images are missing:** some images/canvases may not be accessible to the browser script or supported by the provider; text-only solving may be unreliable when image details are essential.

## Privacy notes

The script extracts visible exercise text, choices, controls, table labels, and visual hints from the current Khan Academy page. It may also attach visible exercise images. When you solve a question, that snapshot is sent to the OpenCode server you configured. If that server is connected to a hosted model provider, the question and attached images may be processed by that provider. Do not use auto mode on pages containing information you do not want to send.

The userscript has localhost access via the userscript manager's request API and makes requests to OpenCode. Review the source before installing it.

## Links

- [OpenCode installation](https://opencode.ai/docs/)
- [OpenCode server API](https://opencode.ai/docs/server/)
- [OpenCode models](https://opencode.ai/docs/models/)
- [OpenCode Zen](https://opencode.ai/docs/zen/)
- [Violentmonkey](https://violentmonkey.github.io/)
- [Tampermonkey](https://www.tampermonkey.net/)

## License

No license has been added yet. Until one is chosen, standard copyright restrictions apply.
