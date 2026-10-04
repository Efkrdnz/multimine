# Tables: the project's numbers, linked to the code

## What it is for

A chat that wants to know a spell's mana cost reads the spell's class; one that wants every spell's
numbers reads every class. Tables keep those numbers in one place, readable at a glance, editable by
hand, and linked to the literals in the code - so reading and changing a value needs no model at
all, and a chat that has the table as context needs no file reads for it.

## How it works

- **A table** is `.multimine/tables/<id>.json` (`src/shared/tables/model.ts`): columns (text,
  number, choice with colours, yes/no, each with an optional note), rows, and per cell an optional
  **code link**: file, line, and the text right before and after the value (`MANA_COST = ` ... `;`).
  It is committed with the project.
- **Finding a value** (`src/shared/tables/links.ts`): the link's line first, then the nearest line
  with the same text around it, so the link survives the code moving. The literal is read as a value
  (`2.5f` -> 2.5, `"fire"` -> fire) and written back in the same style (3 -> `3.0f`).
- **The code is the truth.** Opening or refreshing a table reads every linked value from its file;
  a value changed in the code replaces the table's. A link whose text is gone is marked, not guessed.
- **Editing** a linked cell marks it pending. **Review & apply** shows each line before and after,
  writes the files, reads them back, and reports any value that did not take.
- **`/table ...`** in a chat (or **Make one with AI** in the tool) gives the turn the request, the
  format and the existing tables (`src/shared/tables/prompt.ts`). The chat saves with `save_table`,
  which checks every link against its file, keeps the code's values, drops and reports the links that
  do not match, keeps the user's context switch, and puts a card in the chat. `read_table` reads one.
- **Ideas**: a row the user adds is an idea (not in the code). Its values are reference values in
  context, and **Build it** sends it to a chat with the values and the instruction to link it back.
- **Context for chats**: switched-on tables go into every chat's system prompt as a compact markdown
  table (capped at 6,000 characters each, 16,000 in all), with the files they come from.
- **Charts**: a line per numeric column across the rows on one shared axis (or each as a % of its
  own max), and a donut of one column (counted, or a numeric column summed), past eight slices "Other".
