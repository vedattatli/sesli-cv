"""Best-effort in-memory sliding-window rate limiter (per process / Vercel instance).

It does not survive cold starts and is not shared between instances; it only blunts bursts
from one client. Thread-safe because one instance may serve concurrent requests.
"""

import math
import threading
import time
from collections import deque


class RateLimiter:
    def __init__(self, limit=30, window=600.0, clock=time.monotonic, max_keys=10000):
        self.limit = limit
        self.window = window
        self.clock = clock
        self.max_keys = max_keys
        self._hits = {}
        self._lock = threading.Lock()

    def hit(self, key, limit=None):
        """Record one request for `key`. Returns (allowed, retry_after_seconds)."""
        limit = self.limit if limit is None else limit
        if limit <= 0:
            return True, 0
        now = self.clock()
        cutoff = now - self.window
        with self._lock:
            q = self._hits.get(key)
            if q is None:
                if len(self._hits) >= self.max_keys:
                    self._prune(cutoff)
                q = self._hits[key] = deque()
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= limit:
                retry = max(1, math.ceil(q[0] + self.window - now))
                return False, retry
            q.append(now)
            return True, 0

    def _prune(self, cutoff):
        for k in [k for k, q in self._hits.items() if not q or q[-1] <= cutoff]:
            del self._hits[k]
        if len(self._hits) >= self.max_keys:  # still full: drop the oldest half
            oldest = sorted(self._hits, key=lambda k: self._hits[k][-1])
            for k in oldest[: len(oldest) // 2]:
                del self._hits[k]

    def reset(self):
        with self._lock:
            self._hits.clear()
