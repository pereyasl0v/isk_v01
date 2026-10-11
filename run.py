"""Windows-friendly single-process entry point; frontend already built."""
import socket
import threading
import time
import urllib.request
import webbrowser
import uvicorn

def open_when_ready():
    for _ in range(30):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8000/',timeout=1) as response:
                if response.status==200:
                    webbrowser.open('http://127.0.0.1:8000/')
                    return
        except OSError:
            time.sleep(.5)

if __name__=='__main__':
    with socket.socket() as sock:
        try:
            sock.bind(('127.0.0.1',8000))
        except OSError:
            raise SystemExit('Port 8000 is busy. Stop the previous server and run again.')
    threading.Thread(target=open_when_ready,daemon=True).start()
    uvicorn.run('backend.main:app',host='127.0.0.1',port=8000,log_level='warning',access_log=False)
