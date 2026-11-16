---
name: notes
description: The notes kept by the Notes plugin — list them.
runtime:
  scripts:
    - filename: scripts/list.py
      language: python
      description: Lists the notes kept by the Notes plugin, newest first.
      input_schema: { type: object, properties: {} }
    - filename: scripts/add.py
      language: python
      description: Adds a note (used by the plugin's page).
      llm_callable: false
      input_schema: { type: object, properties: {} }
---
# Notes

`list.py` lists the notes kept by the Notes plugin. Notes are added from the plugin's page.
