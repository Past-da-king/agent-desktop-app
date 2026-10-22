#!/bin/bash
# Prints a pairing offer from a temp node and decodes the terminal QR with OpenCV.
source ~/.nvm/nvm.sh
B=~/agent-desktop-wt/devices-headless/dist-headless/agent-node.mjs
T=$(mktemp -d)
PORT=$((20000 + RANDOM % 30000))
node $B config --port $PORT --url https://127.0.0.1:$PORT --data-dir $T >/dev/null
node $B start --daemon --data-dir $T >/dev/null
node $B offer --data-dir $T > $T/offer.txt
node $B stop --data-dir $T >/dev/null
python3 - "$T/offer.txt" <<'EOF'
import sys, numpy as np, cv2
text = open(sys.argv[1], encoding='utf8').read()
qr_lines = [l for l in text.split('\n') if l and set(l) <= set(' ▀▄█')]
link = [l for l in text.split('\n') if l.startswith('Pairing link:')][0].split(': ', 1)[1]
rows = []
for line in qr_lines:
    top, bottom = [], []
    for ch in line:
        # Light (drawn) is white, a space is dark.
        top.append(255 if ch in '█▀' else 0)
        bottom.append(255 if ch in '█▄' else 0)
    rows += [top, bottom]
img = np.array(rows, dtype=np.uint8)
img = cv2.copyMakeBorder(img, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255)
img = cv2.resize(img, None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
data, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
print('decoded matches link:', data == link, '| modules:', len(rows), 'x', len(rows[0]))
EOF
rm -rf $T
