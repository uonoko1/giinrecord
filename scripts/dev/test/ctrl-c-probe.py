# scripts/dev/test/mutate.test.sh から使う（Issue #542）。
# 本物の PTY で mutate.sh run を起動し、Ctrl-C(0x03) を送って出力を返す。
# `setsid ... &` では bash が SIGINT を無視した状態で生まれるため、trap の検査にならない。
import os, pty, time, sys
R, M = sys.argv[1], sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(R)
    os.execvp("bash", ["bash", M, "run", "--file", "src/app.ts", "--expr", "s/ORIGINAL/MUTANT/", "--", "sleep", "30"])
buf = b""
mark = "当てた".encode()
t0 = time.time()
while mark not in buf and time.time() - t0 < 10:
    try: buf += os.read(fd, 4096)
    except OSError: break
time.sleep(0.4)
os.write(fd, b"\x03")   # 本物の Ctrl-C
t0 = time.time()
while time.time() - t0 < 5:
    try:
        d = os.read(fd, 4096)
        if not d: break
        buf += d
    except OSError: break
print(buf.decode(errors="replace"))
