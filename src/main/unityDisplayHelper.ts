/** The Unity broker's private-display helper (python3), written to <hive>/bin/unity-display.py
 *  before each run. Kept as a string so it ships inside the app bundle with no extra resource. */
export const UNITY_DISPLAY_HELPER = String.raw`# Private X display for one Unity broker run (written by Munder Difflin; do not edit).
# Prints "DISPLAY <n> <server pid>" once the server accepts connections, or "ERROR <reason>".
# Holds the server until stdin closes (the harness ended the run or died), then stops it.
# Xvfb when installed; otherwise Xephyr drawing into an UNMAPPED window on the parent
# display, so nothing is ever shown there and nothing can take focus.
import ctypes, os, signal, subprocess, sys, threading

W, H = int(sys.argv[1]), int(sys.argv[2])
server_bin = sys.argv[3]
server = None
win = None
xd = None

def fail(msg):
    print("ERROR " + msg, flush=True)
    stop()
    sys.exit(1)

def stop(*_):
    if server and server.poll() is None:
        server.terminate()
        try:
            server.wait(3)
        except subprocess.TimeoutExpired:
            server.kill()
    if xd is not None:
        try:
            win.destroy(); xd.sync(); xd.close()
        except Exception:
            pass

def die_with_us():
    ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG
    os.setsid()

signal.signal(signal.SIGTERM, lambda *_: (stop(), sys.exit(0)))
r, w = os.pipe()
if os.path.basename(server_bin) == "Xvfb":
    argv = [server_bin, "-displayfd", str(w), "-screen", "0", f"{W}x{H}x24", "-nolisten", "tcp"]
else:
    try:
        from Xlib import display, X
    except ImportError:
        fail("python3-xlib is not installed (needed for the Xephyr hidden parent)")
    try:
        xd = display.Display()
    except Exception as e:
        fail(f"cannot open the parent display {os.environ.get('DISPLAY')!r}: {e}")
    s = xd.screen()
    win = s.root.create_window(0, 0, W, H, 0, s.root_depth, X.InputOutput, X.CopyFromParent,
                               background_pixel=s.black_pixel)
    xd.sync()
    argv = [server_bin, "-displayfd", str(w), "-parent", hex(win.id), "-screen", f"{W}x{H}",
            "-nolisten", "tcp", "-br", "-noreset"]
try:
    server = subprocess.Popen(argv, pass_fds=(w,), stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=die_with_us)
except OSError as e:
    fail(f"cannot start {server_bin}: {e}")
os.close(w)
got = b""
timer = threading.Timer(20, lambda: server.kill())
timer.start()
while not got.endswith(b"\n"):
    chunk = os.read(r, 64)
    if not chunk:
        break
    got += chunk
timer.cancel()
n = got.strip()
if not n.isdigit() or server.poll() is not None:
    fail(f"{os.path.basename(server_bin)} did not start a display")
if int(n) == 0:
    fail("the server took display :0")
print(f"DISPLAY {int(n)} {server.pid}", flush=True)
sys.stdin.read()
stop()
`;
