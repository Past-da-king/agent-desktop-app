package com.past9.phoneaos.sync

/**
 * A Hybrid Logical Clock stamp: wall-clock millis plus a counter, tagged with the device id.
 *
 * Why not just System.currentTimeMillis(): two devices can create or edit rows while their clocks
 * disagree, and two edits can land in the same millisecond. An HLC keeps time close to wall-clock
 * (so it reads sensibly) but always moves strictly forward and breaks ties deterministically by
 * device id, so every device independently agrees on which edit wins. Last-writer-wins is then
 * resolved identically everywhere, with no server arbitration.
 */
data class HlcStamp(val millis: Long, val counter: Int, val device: String) : Comparable<HlcStamp> {
    /** Compact, sortable string form: <millis>-<counter>-<device>. */
    fun encode(): String = "$millis-$counter-$device"

    override fun compareTo(other: HlcStamp): Int {
        millis.compareTo(other.millis).let { if (it != 0) return it }
        counter.compareTo(other.counter).let { if (it != 0) return it }
        return device.compareTo(other.device)
    }

    companion object {
        fun decode(s: String): HlcStamp? {
            val parts = s.split('-')
            if (parts.size < 3) return null
            val millis = parts[0].toLongOrNull() ?: return null
            val counter = parts[1].toIntOrNull() ?: return null
            return HlcStamp(millis, counter, parts.drop(2).joinToString("-"))
        }
    }
}

/** A monotonic clock for one device. Thread-safe enough for our use (synchronized on the instance). */
class Hlc(private val device: String) {
    private var millis = 0L
    private var counter = 0

    /** A stamp for a local event happening now. */
    @Synchronized fun now(): HlcStamp {
        val wall = System.currentTimeMillis()
        if (wall > millis) { millis = wall; counter = 0 } else counter++
        return HlcStamp(millis, counter, device)
    }

    /** Fold in a stamp seen from another device, so our next local stamp is greater than it. */
    @Synchronized fun observe(remote: HlcStamp) {
        val wall = System.currentTimeMillis()
        val m = maxOf(wall, millis, remote.millis)
        counter = when {
            m == millis && m == remote.millis -> maxOf(counter, remote.counter) + 1
            m == millis -> counter + 1
            m == remote.millis -> remote.counter + 1
            else -> 0
        }
        millis = m
    }
}
