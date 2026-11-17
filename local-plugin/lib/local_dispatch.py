"""Bounded companion dispatch so a blocking local read cannot stop stdin routing."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor


class BoundedExecutor:
    def __init__(self, workers=2, pending=4):
        self.pool=ThreadPoolExecutor(max_workers=workers,thread_name_prefix='local-mcp')
        self.slots=threading.BoundedSemaphore(workers+pending)

    def submit(self, operation, complete, failed):
        if not self.slots.acquire(blocking=False): return False
        queued=time.perf_counter()
        def execute():
            started=time.perf_counter()
            try:
                answer=operation()
            except Exception as exc:
                failed(exc,{'queueMs':round((started-queued)*1000),'serviceMs':round((time.perf_counter()-started)*1000)})
            else:
                complete(answer,{'queueMs':round((started-queued)*1000),'serviceMs':round((time.perf_counter()-started)*1000)})
            finally:
                self.slots.release()
        try: self.pool.submit(execute)
        except Exception:
            self.slots.release();raise
        return True

    def shutdown(self):
        self.pool.shutdown(wait=True,cancel_futures=True)
