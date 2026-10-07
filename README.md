# Picture Buzzer

A real-time buzzer for picture-guessing games. One static `index.html` gives you three synced views:

| View | URL | Who |
|---|---|---|
| Host | `index.html?view=host` | You. Load images, run rounds, judge buzzes, keep score |
| Player | `index.html?view=player&room=CODE` | Friends on a phone or computer. Big BUZZ button (or Space) |
| Stream | `index.html?view=stream&room=CODE` | OBS browser source, 1920×1080. Never shows the answer before you reveal |

Opening `index.html` with no parameters shows a landing page (Host / Join with code / Stream).

## New in 1.1
- **Full-screen viewer**: tap or click any picture (on the player or host screen) to open it full screen. Pinch or double-tap to zoom on phones; scroll wheel or click to zoom and drag to pan on desktop. Close with ✕, Esc, a tap outside the picture, or the phone's Back gesture. It closes by itself if the host reveals, changes round, or blanks the screen, so it never shows a stale picture or the answer early.
- **Compact buzz bar** on the player screen, pinned at the bottom, so the picture gets most of the screen. Space still buzzes.
- **Blank / "Get ready" screen** (`B`, or the *Blank screen* button): players and the stream see your editable "Get ready" text (the stream also shows the scoreboard) while you still see the round. Buzzers are locked while blank. Optionally start every round blank (*Game setup*).
- **Test rounds**: tick *Test round* in Game setup (or `"test": true` in a game file) for tech-check rounds. A correct answer scores 0, and leaving the last test round offers a score reset. **Reset scores** zeroes scores at any time.
- Stream answers shrink to fit on one line.

## How it works
- No backend and no accounts. The **host's browser holds the game state**. Players and the stream view connect to it peer-to-peer (WebRTC) through the free public PeerJS broker (`0.peerjs.com`). PeerJS 1.5.5 loads from unpkg, with jsDelivr as a fallback.
- The host registers the PeerJS ID `picbuzz-<roomcode>`, and clients connect to that ID.
- Images are resized and compressed in the browser (max 1600 px by default, JPEG quality 0.85). They're sent to clients in chunks only when needed: the current round's question images, plus the next round's question images as a prefetch. The answer image and answer note are never sent before you reveal, and the host refuses requests for them.
- The host decides buzz order: the first `buzz` message to arrive wins, later ones are recorded with their delay (+0.03 s and so on), and locked-out players are ignored.
- The game, scores, players, and settings are saved in localStorage and the images in IndexedDB, so refreshing the host loses nothing. Clients reconnect automatically: they ping every 2 s and reconnect if they hear nothing for 15 s, and a player gets back their identity through a per-room client ID.

## Host quick start
1. Open `index.html?view=host`. A room code is generated (click ✎ to set your own).
2. **Game setup → Load a game**: drag in a folder, image files, a `.zip`, or a saved game `.json`. You can also paste image URLs.
3. Add players (or let friends type their names). Copy the **Player link** to friends.
4. OBS: **Sources → + → Browser** → paste the **Stream link**, set Width 1920 and Height 1080, and tick “Control audio via OBS” if you want the buzz sounds. Pick *Transparent* or *Green screen* before copying the link for an overlay look. Press `B` in the stream view to cycle backgrounds while previewing.
5. Play: `→` next round (opens the buzzers), the first buzz lights up, then `C` correct (+points) or `W` wrong (locks that player out and reopens for the others), `R` reveal. `O` open, `L` lock, `X` reset buzzers (clears lockouts), `←` previous.

## Loading formats
- **Folder / files / zip**: the first number in a filename sets the round. Names containing `answer`/`ans`/`reveal`/`solution` become the answer image. Two other images with the same number show side by side as **A** and **B**.
- **Answer notes**: `answers.json` (`{"1": "note"}` or `{"1": {"title","prompt","note","points"}}`), or a `.md`/`.txt` file with `01: note` lines, `**06: Title** …` blocks, or `| 01 | prompt | answer |` table rows.
- **Pasted URLs**: one round per line, `q_url [| q2_url] [> answer_url] [ # note]`. Images that can't be loaded cross-origin are linked instead of embedded, so viewers fetch them straight from the source.
- **Game file** (`.picbuzz.json`, made with *Export*): `{format:"picture-buzzer-game", version:1, title, defaultPoints, wrongPenalty, rounds:[{title,prompt,note,points,test?,question:[dataURL|url,…], answer:dataURL|url|null}]}`.

## Network notes and limitations
- Everyone needs internet access for the PeerJS broker (signaling) and the CDN.
- WebRTC uses public STUN servers (Google and Cloudflare). **There is no TURN relay by default.** The TURN servers bundled with PeerJS (`eu-0/us-0.turn.peerjs.com`) no longer resolve in DNS, and every free TURN service now requires an account. Most home and mobile connections work with STUN alone. If one player can't connect (strict corporate or school firewall, some carrier-grade NAT), add a TURN server under **Game setup → Connection help**. It's added to the share links automatically. You can also use `?turn=turn:host:3478&turnuser=u&turnpass=p` on every URL.
- Self-hosted PeerJS server: add `&peerhost=…&peerport=…&peerpath=…` to all URLs.
- Opening `index.html` straight from disk (`file://`) works, but share links will point at your disk. Friends then need their own copy of the file and the room code (the landing page has a Join box).
- Keep the host tab open. It's the game's brain.

## Development
Source lives in `src/` (`head.html`, `style.css`, `core.js`, `host.js`, `clients.js`). Run `python3 src/build.py` to inline everything into `index.html`.
