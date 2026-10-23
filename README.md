# Gamaka Annotator

A browser app for marking gamakas in Carnatic recordings and exporting them to Excel.

## Run

Double-click `index.html` to open it in Chrome or Edge. You need an internet connection the first time, because the waveform and Excel libraries load from a CDN.

You can also serve the folder locally:

```bash
python -m http.server 8765
```

Then open http://localhost:8765.

## How to annotate

1. Click **Upload song**, or drag an audio file onto the page.
2. Press **Space** to play. Press **Space** again to pause, which drops a boundary at the playhead. Press **Space** to carry on.
3. Each section between two boundaries is one gamaka. Type its name in the box under that section, or in the table. Suggestions appear as you type.
4. **Undo** (Ctrl+Z) or **Redo** (Ctrl+Y) removes or restores a boundary or a name. You can also drag a boundary line to adjust it, or double-click it to delete it.
5. Click **Export Excel (this song)**. The file `<song name>_gamakas.xlsx` has these columns: Song Name, S.No, Timestamp (`1:03.25 - 1:04.10`), Gamaka Type, Start/End/Duration in seconds.
6. Upload the next song and do the same again.

Sections with no name are left out of the export. Tick **Include unnamed sections** if you want them in.

## Pitch contour

Under the waveform is a pitch line with a svara grid (S R₁ R₂ G₂ G₃ M₁ M₂ P D₁ D₂ N₂ N₃). A dot above a svara means tara sthayi and a dot below means mandra. Gamakas show up as shapes: a kampita is a wave, a jaaru is a slide, and a nokku is a spike.

- Pitch analysis starts by itself after you upload. It takes a few seconds for each minute of audio.
- **Sa** is guessed automatically. Check it by ear and pick the right shruti (note, kattai or Hz) if it's wrong. A common mistake is choosing P instead of S. If that happens, pick the note a fifth lower. Sa is saved with each song.
- Hover over the line to see the exact time, Hz, svara and cents offset. Click or drag on it to move the playhead.
- **Clean-up** hides uncertain pitch points. Raise it when violin, mridangam or tanpura cause stray dots.
- **🎤 Vocal track for pitch…**: for concert recordings, separate the vocal first with a free tool such as Demucs or Ultimate Vocal Remover, then load the vocal file here. You still hear and annotate the full mix, but the pitch line comes from the vocal and is much cleaner. The vocal file must be the same length as the song. It isn't saved, so load it again each time you open the song.

## Other features

- **Playhead**: click or drag anywhere on the waveform, or drag the seek bar under it, to move through the song. There's a volume slider next to the seek bar.
- **Speed**: 0.5× or 0.75× playback keeps the pitch, so fast gamakas are easier to mark.
- **Zoom** stretches the waveform, and the name boxes stay lined up with it.
- **M** adds a boundary without pausing. **←/→** jumps 2 s, and **Shift+←/→** jumps 0.2 s.
- **Autosave**: annotations are saved in this browser. Re-upload the same file to pick up where you stopped.
- **Export all songs** makes one workbook with an "All Songs" sheet and one sheet for each song.
