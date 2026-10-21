# 5 — Ask, Then Edit

*You'll learn: the Ask tab — Claude answering data questions by writing
analysis programs — and the round-trip that makes it more than a chatbot: every
AI-run program lands in the Graph tab where you can inspect it, change it, and
re-run it, with the conversation kept in the loop.*

The three tabs are three authors for the *same* language. Ask is the fastest
first draft; the Graph tab is where you make the analysis yours.

## Set up the Ask tab

1. Open **⚗ Analysis → Ask**. First visit wants an Anthropic API key: paste
   one and press **Save key**. It's stored in this browser's localStorage and
   sent only to the Anthropic API — the *data* never goes anywhere. Programs
   run locally in your page, exactly like preset and graph runs; the model only
   sees the program it wrote and the summary statistics that came back
   (r values, means, coverage — a few hundred bytes).
2. The model gets a system prompt generated from the live layer catalog, so it
   knows what data exists, the coverage windows, and the op set — and its
   `run_analysis` tool schema enumerates the real language (op names and layer
   keys as enums). If a program is still wrong in any way, the engine's
   validator sends the structured errors back and the model repairs it in the
   same turn.

## Ask

3. Type: **"Is there a correlation between sea temperature and wind?"**

   Watch the sequence: a thinking note, then a collapsible
   **▶ ran analysis program (5 nodes)** line — expand it and you'll recognize
   everything from tutorial 2: two `layer` nodes, a temporal `correlate`, a
   `display`, an `answer`. The map takes over with the r map, the results area
   fills in, and the model narrates the actual numbers from the run — it can't
   make them up, because the only numbers it has are the ones the engine
   returned.

4. If the model ever emits an invalid program, the same structured validation
   errors you've seen as red badges go back to it as the tool result, and it
   repairs the program and retries within the same turn. You'll see two
   program expanders in that case — the broken draft and the fix.

## Steal the program

5. Switch to the **Graph** tab: the model's program is already loaded (the
   Graph tab always shows the most recent run, whoever authored it). This is
   the "show your work" view — every claim in the chat corresponds to a node
   you can poke.
6. Edit it. Change the correlate window (`start` on both layers), or insert a
   **mask** with a `region` node to focus the tropics. Press **▶ Run**. The
   map and answers update — no model call, no tokens, sub-second.
7. Now go back to **Ask** and follow up: **"what about only in the tropics?"**
   Your manual run was appended to the conversation (as a note carrying the
   edited program), so the model knows what's currently on screen and edits
   *from* it rather than starting over — usually changing a node or two, which
   you can verify in the next program expander.

## Keep the good ones

8. When an AI-drafted analysis is worth keeping, save it from the Graph tab
   (**💾** with a name), or **🔗 Copy link** to share the exact program as a
   URL. Links and presets are plain program JSON — nothing about them remembers
   which tab authored them.

## Which tab when

| Situation | Reach for |
| --- | --- |
| A question in your head, unsure how to express it | **Ask** — the model picks ops, windows, and regions, and narrates caveats |
| Repeating a standard analysis | **Presets**, or a saved graph |
| "Almost right, but…" | **Graph** — edit the last run directly |
| Learning what the language can do | The **built-in** graphs, then these tutorials |

**One habit to build:** whatever the author — model, preset, or you — the
result always arrives as *map + numbers + the program that made them*. Reading
the program is how you trust the answer.

---

*That's the series. The [module guide](../analysis.md) is the
complete node-type reference; the
[deep-dive](../deep-dive.md) covers
the explorer around the analysis engine — the data feeds, the time-lapse
machinery, and how the display takeover works.*
