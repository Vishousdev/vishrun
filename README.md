# Vishrun

Vishrun is a [Lumiverse](https://github.com/prolix-oc/Lumiverse) Spindle extension that makes SillyTavern character cards and presets work in Lumiverse: their in-message widgets, their variables (MVU) and their JS-Slash-Runner scripts.

> [!WARNING]
> **Vishrun runs JavaScript that comes from character cards and presets. Only use cards and presets from sources you trust.**
>
> There are two kinds of code, with different risks:
>
> - **Widgets inside messages** run in Lumiverse's sandboxed frames. They cannot read the Lumiverse page or act as you.
> - **Card and preset scripts** (JS-Slash-Runner scripts) run on the Lumiverse page itself, as they do in SillyTavern. While a card's chat is open, or a preset is active, its scripts can do anything Lumiverse can do in your browser. A malicious script could:
>   - read your chats, characters, presets and lorebooks
>   - change or delete your data, or send messages
>   - send your data to other websites
>
> Some scripts also download more code from the internet each time they run, so what they do can change without the card or preset changing.
>
> Before you allow any scripts:
>
> 1. Make sure the card or preset comes from a source you trust.
> 2. Understand what its scripts do and how they could affect your data.
> 3. If in doubt, choose **Not now**.
>
> Vishrun asks once per card and once per preset before running its scripts, like JS-Slash-Runner does. We are not responsible for any loss or damage caused by third-party cards, presets or scripts.

## What it does

### Widgets in messages

Cards carry HTML/CSS/JS widgets in their regex scripts (`regex_scripts`): status bars, phones, menus, story pickers. Vishrun renders them inside chat messages.

- Triggers: placeholders (`【FOO】`), paired tags (`<TAG>…</TAG>`, one or several), and delimited captures.
- Replacements: `$0`, `$1…$N` and `{{match}}`, plus Lumiverse macros and variables (`{{getvar::…}}`, `{{user}}`, `{{char}}`…).
- Widgets run in sandboxed frames that resize to their content. Reloads, swipes and edits re-render them without changing the saved chat.
- External images, fonts, CSS backgrounds and audio load through Lumiverse's proxy.
- Common libraries ship with Vishrun, so cards that load them from a CDN work: Tailwind, React, ReactDOM, Babel, Vue and Arco Design. See [`THIRD_PARTY.md`](src/vendor/cdn/THIRD_PARTY.md).
- Widgets get the usual JS-Slash-Runner helpers: chat messages, variables, events, `triggerSlash`, jQuery and lodash.
- Full HTML pages that a regex or a reply puts in a code block render as widgets, as in SillyTavern.
- Lumiverse imports a card's regexes as its own rules, but drops their scripts. Vishrun takes over the rows it needs to render itself, and fixes `$0` in the rows Lumiverse keeps.

### Variables (MVU)

Cards that use MagVarUpdate keep their state without the MVU script:

- Starting values come from the card's `[initvar]` lorebook entries or `<initvar>` blocks in the greeting.
- Update commands in replies (`_.set`, `_.add`, `_.insert`, `_.remove`…) are replayed in order, following the active swipe of each message.
- Update blocks are hidden from the displayed message, and status bar widgets read the current values.
- MVU zod schemas that cards register are applied (defaults and limits).

### Card and preset scripts (JS-Slash-Runner)

Vishrun runs the scripts stored in presets and character cards (`tavern_helper`), each in its own hidden frame, after you allow them.

- Card scripts run while that card's chat is open. Preset scripts run while that preset is active. Switching stops them and removes what they added to the page.
- Script buttons appear in Lumiverse's Extras menu.
- Supported APIs:
  - **Events:** message sent, received, edited, deleted, swiped and rendered, generation, chat and connection changes.
  - **Variables:** global, chat, character and script.
  - **Presets:** read the active preset, turn its entries on and off, change "start reply with".
  - **Lorebooks:** read and edit the character's lorebooks, in both the newer and the older JS-Slash-Runner formats.
  - **Regexes:** read the card's and global regexes, add and update them.
  - **Chat:** read messages, edit them, hide and show them.
  - **Slash commands:** `/send`, `/trigger`, `/input`, `/popup`, `/echo`, `/pass`, with macros.
  - **Globals:** jQuery bound to the page, lodash, zod, Vue, `toastr`, Font Awesome.
- SillyTavern page names (`#chat`, `.mes`, `.mes_text`) are added while scripts run, so scripts that look for messages find them.
- Scripts can load more code with `import()`. A script that only loads MagVarUpdate is skipped, since Vishrun handles MVU itself.
- Presets imported before Lumiverse kept SillyTavern's prompt ids can be linked to their original file once, so scripts find their entries.

## Not supported

- Scripts that rely on SillyTavern internals outside the JS-Slash-Runner API: its popup system, its slash command parser, or saving the character card.
- Slash commands other than the ones listed above.
- Script APIs that generate replies or inject prompts (`generate`, `generateRaw`, `injectPrompts`).
- Deleting regexes from scripts. Scripts can add and update them only.
- Widgets taller than 4000 px are cut at that height and scroll inside their frame (a Lumiverse limit).
- Cards with an empty main greeting start with an empty chat. Pick a greeting with Lumiverse's greeting picker.

Vishrun aims to behave like SillyTavern with JS-Slash-Runner. A card or preset that is broken in SillyTavern, for example by a partial translation, behaves the same way here.

## Install

1. In Lumiverse, open **Extensions**, click **Add extensions**, choose **Install from source**, paste this repository's URL and install.
2. Enable Vishrun and grant its permissions in the Extensions panel. The privileged ones (marked ★) must be granted by the owner or an admin.
3. Refresh the browser tab.

| Permission | Why Vishrun needs it |
|---|---|
| `cors_proxy` ★ | Load external images, fonts and audio in widgets. |
| `unsafe_eval` ★ | Widgets that compile templates at runtime (Vue, Babel). |
| `regex_scripts` | Read the card's imported regex rules. |
| `regex_scripts_unrestricted` ★ | Take over or fix the card's imported rules, and let scripts edit regexes. |
| `chats` | Read chat messages for widgets, MVU and scripts. |
| `chat_mutation` | Let widgets and scripts edit, hide and show messages. |
| `characters` | Read the card's regexes, greetings and scripts. |
| `world_books` | MVU starting values, and lorebook access for scripts. |
| `presets` | Preset scripts. |

Without a permission, the features that need it stay off. The rest of Vishrun keeps working.

## Development

```bash
bun install
bun test
bun run build   # dist/frontend.js and dist/backend.js
```

For local development, clone the repository to `Lumiverse/data/extensions/vishrun/repo`.

## Credits

Vishrun follows the behavior of [JS-Slash-Runner](https://github.com/N0VI028/JS-Slash-Runner) (Tavern Helper) and [MagVarUpdate](https://github.com/MagicalAstrogy/MagVarUpdate) so that cards made for them work in Lumiverse. It is not affiliated with either project.
