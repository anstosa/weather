"""lock completion-based request spacing without HTTP or wall sleeps."""

import unittest

import rain_request_spacing as spacing


class FakeClock:
    """record deterministic monotonic time and requested sleeps."""

    # start each scenario at an explicit monotonic instant
    def __init__(self, now=0.0):
        self.now = now
        self.sleeps = []
        self.undersleep_once = False

    # expose monotonic time without advancing it implicitly
    def clock(self):
        return self.now

    # optionally wake early once to exercise the deadline loop
    def sleep(self, seconds):
        self.sleeps.append(seconds)
        if self.undersleep_once:
            self.undersleep_once = False
            self.now += seconds / 2
        else:
            self.now += seconds


class RequestSpacingTests(unittest.TestCase):
    # a first attempt needs no artificial delay
    def test_first_attempt_has_no_wait(self):
        clock = FakeClock(100.0)
        limiter = spacing.RequestSpacing(clock.clock, clock.sleep)
        limiter.wait()
        self.assertEqual(clock.sleeps, [])
        self.assertEqual(clock.now, 100.0)

    # slow bookkeeping before the request does not count as post-completion spacing
    def test_slow_pre_request_bookkeeping(self):
        clock = FakeClock(4.0)
        limiter = spacing.RequestSpacing(clock.clock, clock.sleep)
        clock.now += 3.0
        limiter.mark_completed()
        clock.now += 0.6
        limiter.wait()
        self.assertGreaterEqual(clock.now, 8.05)
        self.assertAlmostEqual(clock.sleeps[-1], 0.45)

    # a retry waits fifteen seconds from the failed attempt's completion
    def test_retry_backoff_from_completion(self):
        clock = FakeClock(20.0)
        limiter = spacing.RequestSpacing(clock.clock, clock.sleep)
        limiter.mark_completed(retry=True)
        clock.now += 4.0
        limiter.wait()
        self.assertEqual(clock.now, 35.05)
        self.assertEqual(len(clock.sleeps), 1)
        self.assertAlmostEqual(clock.sleeps[0], 11.05)
        # a later successful attempt reverts to the one-second spacing
        limiter.mark_completed()
        limiter.wait()
        self.assertAlmostEqual(clock.now, 36.1)

    # early wakeups cannot authorize a start before the monotonic deadline
    def test_undersleep_rechecks_deadline(self):
        clock = FakeClock(0.0)
        clock.undersleep_once = True
        limiter = spacing.RequestSpacing(clock.clock, clock.sleep)
        limiter.mark_completed()
        limiter.wait()
        self.assertEqual(len(clock.sleeps), 2)
        self.assertAlmostEqual(clock.sleeps[0], 1.05)
        self.assertAlmostEqual(clock.sleeps[1], 0.525)
        self.assertEqual(clock.now, 1.05)

    # no clock or sleep is invoked for a first-attempt wait
    def test_first_wait_is_clock_free(self):
        # injecting a failing clock proves the empty state returns first
        def forbidden():
            raise AssertionError('first wait sampled clock')

        limiter = spacing.RequestSpacing(forbidden, forbidden)
        limiter.wait()


# run only pure timing tests when invoked directly
if __name__ == '__main__':
    unittest.main()
