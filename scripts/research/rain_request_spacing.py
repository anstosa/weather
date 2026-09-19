"""space bounded source requests from the prior completed attempt."""

import time


class RequestSpacing:
    """wait from completion, not from pre-request bookkeeping."""

    # permit deterministic clocks without changing production timing
    def __init__(self, clock=time.monotonic, sleep=time.sleep):
        self.clock = clock
        self.sleep = sleep
        self.not_before = None

    # record the prior attempt's completion after its receipt is durable
    def mark_completed(self, retry=False):
        # leave fifty milliseconds beyond the frozen policy minimum
        self.not_before = self.clock() + (15.05 if retry else 1.05)

    # recheck the deadline after every sleep, including undersleeps
    def wait(self):
        # the first request has no predecessor to space from
        if self.not_before is None:
            return
        while True:
            remaining = self.not_before - self.clock()
            # a monotonic deadline, not sleep's return, authorizes a start
            if remaining <= 0:
                return
            self.sleep(remaining)
