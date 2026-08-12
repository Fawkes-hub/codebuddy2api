"""为后台上游请求提供可取消的随机启动间隔。"""

import asyncio
import random
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, Awaitable, Callable


class BackgroundRequestPacer:
    """串行分配请求启动许可，但不等待已启动的请求完成。"""

    def __init__(
            self,
            minimum_delay_seconds: float,
            maximum_delay_seconds: float,
            *,
            uniform_factory: Callable[[float, float], float] = random.uniform,
            monotonic_factory: Callable[[], float] = time.monotonic,
            sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._minimum_delay_seconds = minimum_delay_seconds
        self._maximum_delay_seconds = maximum_delay_seconds
        self._uniform_factory = uniform_factory
        self._monotonic_factory = monotonic_factory
        self._sleep = sleep
        self._lock = asyncio.Lock()
        self._last_started_at = None
        self._delay_after_last_start = 0.0

    def reset(self) -> None:
        """开始新生命周期时清除旧事件循环与上次启动状态。"""
        self._lock = asyncio.Lock()
        self._last_started_at = None
        self._delay_after_last_start = 0.0

    @asynccontextmanager
    async def turn(self) -> AsyncIterator[Callable[[], None]]:
        """等待启动窗口；调用返回函数后，下一请求才开始计算间隔。"""
        await self._lock.acquire()
        released = False
        try:
            if self._last_started_at is not None:
                remaining = (
                    self._last_started_at
                    + self._delay_after_last_start
                    - self._monotonic_factory()
                )
                if remaining > 0:
                    await self._sleep(remaining)

            def mark_started() -> None:
                nonlocal released
                if released:
                    raise RuntimeError("background request turn is already released")
                self._last_started_at = self._monotonic_factory()
                self._delay_after_last_start = self._uniform_factory(
                    self._minimum_delay_seconds,
                    self._maximum_delay_seconds,
                )
                self._lock.release()
                released = True

            yield mark_started
        finally:
            if not released:
                self._lock.release()
                released = True
