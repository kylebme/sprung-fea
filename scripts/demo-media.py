"""Cuts output/demo (from scripts/record-demo.mjs) into the README media.

Each GIF runs between its clip's start and end marks; the MP4 runs from the
first mark to the last. Each screencast frame is held until the next repaint,
so the clips keep the recorded timing. Needs ffmpeg on PATH.
"""

import json
import subprocess
from pathlib import Path

REC = Path("output/demo")
MEDIA = Path("docs/media")
timeline = json.loads((REC / "timeline.json").read_text())
frames = timeline["frames"]
marks = {m["name"]: m["t"] for m in timeline["marks"]}
CLIPS = {
    name.removesuffix(":start"): (t, marks[name.replace(":start", ":end")])
    for name, t in marks.items()
    if name.endswith(":start")
}
CLIPS["demo"] = (min(marks.values()), max(marks.values()))


def concat_list(path, t0, t1):
    first = max([i for i, f in enumerate(frames) if f["t"] <= t0] or [0])
    lines = []
    for i in range(first, len(frames)):
        start = max(frames[i]["t"], t0)
        if start >= t1:
            break
        end = min(frames[i + 1]["t"] if i + 1 < len(frames) else t1, t1)
        lines += [f"file 'frames/{frames[i]['name']}'", f"duration {end - start:.4f}"]
        last = frames[i]["name"]
    lines.append(f"file 'frames/{last}'")
    path.write_text("\n".join(lines) + "\n")


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *args], check=True)


MEDIA.mkdir(parents=True, exist_ok=True)
for name, (t0, t1) in CLIPS.items():
    listing = REC / f"{name}.txt"
    concat_list(listing, t0, t1)
    mp4 = REC / f"{name}.mp4"
    ffmpeg(
        "-f", "concat", "-safe", "0", "-i", str(listing),
        "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20",
        "-preset", "slow", "-movflags", "+faststart", str(mp4),
    )
    if name == "demo":
        mp4.replace(MEDIA / "demo.mp4")
        continue
    ffmpeg(
        "-i", str(mp4),
        "-vf",
        "fps=15,scale=1120:-1:flags=lanczos,split[a][b];"
        "[a]palettegen=max_colors=192:stats_mode=diff[p];"
        "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
        str(MEDIA / f"{name}.gif"),
    )
    print(name, f"{t1 - t0:.1f} s")
