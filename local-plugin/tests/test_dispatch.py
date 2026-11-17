import importlib.util
from pathlib import Path
import threading
import unittest
import time

SOURCE=Path(__file__).resolve().parents[1]/'lib/local_dispatch.py'
spec=importlib.util.spec_from_file_location('dispatch_under_test',SOURCE)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class DispatchTests(unittest.TestCase):
    def test_two_operations_overlap_and_queue_is_bounded(self):
        pool=module.BoundedExecutor(workers=2,pending=4)
        release=threading.Event();both=threading.Barrier(3);finished=threading.Event();lock=threading.Lock();answers=[];failures=[];active=0;peak=0
        def operation():
            nonlocal active,peak
            with lock:active+=1;peak=max(peak,active)
            both.wait(timeout=2)
            release.wait(timeout=3)
            with lock:active-=1
            return 'ready'
        def complete(value,timing):
            with lock:
                answers.append((value,timing))
                if len(answers)==6:finished.set()
        def failed(exc,timing):failures.append(str(exc))
        try:
            self.assertTrue(pool.submit(operation,complete,failed));self.assertTrue(pool.submit(operation,complete,failed))
            both.wait(timeout=2)
            for _ in range(4):self.assertTrue(pool.submit(lambda:'queued',complete,failed))
            self.assertFalse(pool.submit(lambda:'overflow',complete,failed))
            release.set()
            self.assertTrue(finished.wait(timeout=2))
        finally:pool.shutdown()
        self.assertEqual(peak,2);self.assertEqual(len(answers),6);self.assertEqual(failures,[])
        self.assertTrue(all(t['queueMs']>=0 and t['serviceMs']>=0 for _,t in answers))

    def test_failed_operation_releases_capacity(self):
        pool=module.BoundedExecutor(workers=1,pending=0);done=threading.Event();errors=[]
        def broken():raise RuntimeError('Expected task failure')
        try:
            self.assertTrue(pool.submit(broken,lambda *_:None,lambda e,t:(errors.append(str(e)),done.set())))
            self.assertTrue(done.wait(timeout=2))
        finally:pool.shutdown()
        self.assertEqual(errors,['Expected task failure'])
