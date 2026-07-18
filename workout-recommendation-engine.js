(function (global) {
  const REFERENCE_DATE = new Date();
  const DAY_MS = 86400000;

  const workoutTypeLabels = {
    recovery: 'Recovery Run',
    easy: 'Easy Run',
    base: 'Base Run',
    long: 'Long Run',
    tempo: 'Tempo Run',
    threshold: 'Threshold Run',
    interval: 'Interval Session',
    race: 'Race Pace Session',
    rest: 'Rest Day'
  };

  const trainingFocusMap = {
    recovery: 'Recovery and adaptation',
    easy: 'Aerobic development',
    base: 'Aerobic endurance',
    long: 'Long-run durability',
    tempo: 'Threshold endurance',
    threshold: 'Steady-state strength',
    interval: 'Speed endurance',
    race: 'Race-specific rhythm',
    rest: 'Recovery and reset'
  };

  const formatPaceSeconds = (seconds) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')} /km`;
  };

  const formatPaceRange = (minSec, maxSec) => {
    if (!Number.isFinite(minSec) || !Number.isFinite(maxSec)) return '--:--';
    return `${formatPaceSeconds(minSec)} – ${formatPaceSeconds(maxSec)}`;
  };

  const formatDistance = (value) => `${Number(value).toFixed(1)} km`;

  const sortActivities = (activities) => [...activities].filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date));

  const getActivityPace = (activity) => {
    if (!activity || !activity.distance || !activity.moving_time) return null;
    return activity.moving_time / activity.distance;
  };

  const getDaysBetween = (activityDate, referenceDate = REFERENCE_DATE) => {
    const ms = Math.max(0, referenceDate.getTime() - new Date(activityDate).getTime());
    return Math.floor(ms / DAY_MS);
  };

  const getRecentRuns = (activities, days = 28) => {
    const cutoff = new Date(REFERENCE_DATE);
    cutoff.setDate(cutoff.getDate() - days);
    return sortActivities(activities).filter(activity => new Date(activity.date) >= cutoff && activity.distance);
  };

  const classifyRun = (activity, easyPace) => {
    if (!activity) return 'easy';
    const name = `${activity.name || ''} ${activity.type || ''}`.toLowerCase();
    const pace = getActivityPace(activity);

    if (/(tempo|threshold|interval|race|hard|quality|fartlek|hill repeat|workout)/.test(name)) {
      return 'hard';
    }

    if (/(recovery|easy|base|steady|aerobic|jog|shakeout)/.test(name)) {
      return 'easy';
    }

    if (/(long)/.test(name)) return 'long';

    const distance = activity.distance || 0;
    const recentLongThreshold = easyPace ? Math.max(8, Math.round((easyPace / 60) * 2)) : 8;
    if (distance >= recentLongThreshold * 1.6 && pace) return 'long';
    if (pace && pace <= easyPace - 18) return 'hard';
    if (pace && pace <= easyPace + 8) return 'easy';
    return 'moderate';
  };

  // FIX #3: estimateEasyPace previously took the median pace of the last 8 runs
  // regardless of intensity, so tempo/interval days pulled the "easy pace"
  // baseline artificially fast. We now do a first pass with a rough pace-only
  // classification to exclude likely-hard efforts before computing the median,
  // then fall back to the unfiltered set only if too little data remains.
  const estimateEasyPace = (activities) => {
    const recent = getRecentRuns(activities, 21).slice(0, 12);
    if (!recent.length) return 320;

    const allPaces = recent.map(getActivityPace).filter(Boolean).sort((a, b) => a - b);
    if (allPaces.length === 0) return 320;

    // Rough baseline from all paces first (used only to detect outlier-fast runs)
    const roughMedian = allPaces[Math.floor((allPaces.length - 1) / 2)];

    // Exclude runs that are clearly hard efforts (much faster than the rough median)
    const filteredPaces = recent
      .map(getActivityPace)
      .filter(pace => pace && pace >= roughMedian - 20)
      .sort((a, b) => a - b);

    const paces = filteredPaces.length >= 3 ? filteredPaces : allPaces;
    const medianIndex = Math.floor((paces.length - 1) / 2);
    return paces[medianIndex] || 320;
  };

  const analyzeTrainingBalance = (activities, easyPace) => {
    const recentRuns = getRecentRuns(activities, 21);
    const categorized = recentRuns.map(activity => ({ activity, label: classifyRun(activity, easyPace) }));

    const hardCount = categorized.filter(item => item.label === 'hard').length;
    const longCount = categorized.filter(item => item.label === 'long').length;
    const totalCount = categorized.length || 1;
    const hardRatio = hardCount / totalCount;
    const recentHardBackToBack = categorized.slice(0, 2).every(item => item.label === 'hard');

    // FIX #4: hardCount is measured over a 21-day window, so "3 hard efforts"
    // is really just 1/week - normal for most plans - yet it was treated the
    // same as 3 hard efforts in a single week. Normalize to a weekly rate so
    // downstream thresholds mean what they say.
    const hardPerWeek = hardCount / 3;

    return {
      categorized,
      hardCount,
      longCount,
      hardRatio,
      hardPerWeek,
      recentHardBackToBack
    };
  };

  const buildPaceWindows = (activities, easyPace) => {
    const recentRuns = getRecentRuns(activities, 28);
    const fastestRecentPace = recentRuns
      .map(getActivityPace)
      .filter(Boolean)
      .sort((a, b) => a - b)[0] || easyPace - 20;

    return {
      recovery: [easyPace + 20, easyPace + 35],
      easy: [easyPace - 5, easyPace + 8],
      base: [easyPace - 5, easyPace + 10],
      long: [easyPace - 2, easyPace + 10],
      tempo: [easyPace - 25, easyPace - 15],
      threshold: [easyPace - 35, easyPace - 20],
      interval: [fastestRecentPace - 18, fastestRecentPace - 8],
      race: [easyPace - 12, easyPace - 3],
      rest: null
    };
  };

  const buildDistanceWindows = (activities, workoutType, weeklyMileage, longRunProgression, avgRunDistance, previousLongRun) => {
    const weeklyTarget = Math.max(20, weeklyMileage * 0.35);
    const avgDist = avgRunDistance || 7;
    const prevLong = previousLongRun || avgDist;

    switch (workoutType) {
      case 'recovery':
        return { min: Math.max(3, avgDist * 0.3), max: Math.max(4, avgDist * 0.5), chosen: Math.round(avgDist * 0.4 * 10) / 10 };
      case 'easy':
        return { min: Math.max(5, avgDist * 0.8), max: Math.max(6, avgDist * 1.1), chosen: Math.round(avgDist * 0.95 * 10) / 10 };
      case 'base':
        return { min: Math.max(6, avgDist * 0.9), max: Math.max(7, avgDist * 1.2), chosen: Math.round(avgDist * 1.05 * 10) / 10 };
      case 'long': {
        const proposed = Math.max(8, Math.min(weeklyTarget, prevLong * 1.08));
        const min = Math.max(8, Math.round(weeklyMileage * 0.25 * 10) / 10);
        const max = Math.max(min + 1, Math.min(weeklyTarget, Math.round(proposed * 10) / 10));
        return { min, max, chosen: Math.round((min + max) / 2 * 10) / 10 };
      }
      case 'tempo':
        return { min: 8, max: 14, chosen: 10 };
      case 'threshold':
        return { min: 8, max: 12, chosen: 10 };
      case 'interval':
        return { min: 6, max: 12, chosen: 8 };
      case 'race':
        return { min: 8, max: 12, chosen: 10 };
      default:
        return { min: 0, max: 0, chosen: 0 };
    }
  };

  const determineWorkout = (activities, metrics, trainingBalance, easyPace) => {
    const { acwr, dist7d, dist28d, restDays, daysSinceLastRun, daysSinceLastHardWorkout, paceCollapse, performanceTrend } = metrics;
    const { hardCount, hardRatio, hardPerWeek, recentHardBackToBack, categorized } = trainingBalance;
    const recentRuns = getRecentRuns(activities, 28);
    const recentRunsLast7 = getRecentRuns(activities, 7);
    const avgRunDistance = recentRuns.length ? recentRuns.reduce((sum, run) => sum + run.distance, 0) / recentRuns.length : 7;
    const weeklyMileage = dist7d;
    const previousLongRun = recentRuns.filter(run => run.distance >= avgRunDistance * 1.15).slice(1, 3).reduce((best, run) => Math.max(best, run.distance), 0) || avgRunDistance;
    const longRunThisWeek = recentRunsLast7.some(run => classifyRun(run, easyPace) === 'long');
    const lastWorkoutType = categorized[0] ? categorized[0].label : 'easy';
    const consecutiveHard = categorized.slice(0, 2).every(run => run.label === 'hard');

    const workoutScores = {
      recovery: 0,
      easy: 0,
      base: 0,
      long: 0,
      tempo: 0,
      threshold: 0,
      interval: 0,
      race: 0,
      rest: 0
    };

    // FIX #4: use hardPerWeek (normalized) instead of raw hardCount over 21 days,
    // so this only fires when someone is genuinely doing >2 hard sessions/week.
    // FIX #2: paceCollapse threshold raised and given less unilateral weight,
    // since it's derived from just the last two runs and is naturally noisy.
    if (Number(acwr) > 1.35 || Number(paceCollapse) > 12 || hardPerWeek >= 2.5 || daysSinceLastHardWorkout <= 1) {
      workoutScores.recovery += 7;
      workoutScores.rest += 3;
      workoutScores.easy += 2;
    }

    // FIX #6: previously combined "haven't run in 4+ days" with "acwr > 1.1",
    // which is a contradictory pairing (low recent volume rarely produces a
    // high ACWR). Split into two clearer, independent signals instead.
    if (daysSinceLastRun >= 4) {
      workoutScores.easy += 2;
      workoutScores.recovery += 1;
    }

    // FIX #1: restDays is now computed correctly (see buildRecommendation),
    // so this condition fires as intended when true rest has been scarce.
    if (restDays <= 2 && Number(acwr) > 1.1) {
      workoutScores.recovery += 2;
      workoutScores.rest += 1;
    }

    if (recentHardBackToBack || consecutiveHard) {
      workoutScores.easy += 4;
      workoutScores.recovery += 3;
      workoutScores.tempo -= 4;
      workoutScores.threshold -= 4;
      workoutScores.interval -= 5;
      workoutScores.race -= 5;
    }

    if (hardRatio > 0.2) {
      workoutScores.easy += 2;
      workoutScores.recovery += 2;
      workoutScores.tempo -= 2;
      workoutScores.interval -= 2;
    }

    if (longRunThisWeek) {
      workoutScores.long -= 7;
      workoutScores.base += 2;
      workoutScores.easy += 1;
    }

    if (weeklyMileage >= 25 && !longRunThisWeek && daysSinceLastRun >= 4) {
      workoutScores.long += 6;
    }

    if (weeklyMileage >= 30 && performanceTrend > 0 && Number(acwr) < 1.25) {
      workoutScores.tempo += 3;
      workoutScores.threshold += 2;
    }

    if (performanceTrend > 4 && hardRatio < 0.2 && weeklyMileage >= 28 && !longRunThisWeek) {
      workoutScores.threshold += 3;
      workoutScores.interval += 2;
    }

    if (performanceTrend > 6 && weeklyMileage >= 35 && Number(acwr) < 1.2 && !longRunThisWeek) {
      workoutScores.interval += 3;
      workoutScores.race += 2;
    }

    if (weeklyMileage < 20 && dist28d >= 50) {
      workoutScores.base += 4;
      workoutScores.easy += 2;
    }

    if (Number(acwr) < 0.85 && dist7d < 15) {
      workoutScores.easy += 2;
      workoutScores.base += 1;
    }

    if (lastWorkoutType === 'hard' || lastWorkoutType === 'long') {
      workoutScores.easy += 3;
      workoutScores.recovery += 2;
    }

    const sorted = Object.entries(workoutScores).sort((a, b) => b[1] - a[1]);
    const selected = sorted[0][0];
    return selected;
  };

  const buildRecommendation = (activities, settings = {}) => {
    if (!activities || !activities.length) {
      return {
        workoutType: 'easy',
        workoutLabel: 'Easy Run',
        distance: 0,
        paceRange: '--:--',
        reason: 'Add a few consistent runs first so the engine can build a meaningful recommendation.',
        explanation: ['Not enough activity history yet to generate a coaching recommendation.'],
        warnings: [],
        trainingFocus: 'Aerobic development',
        status: 'Building',
        fitnessTrend: 'Stable',
        recoveryStatus: 'Ready to begin',
        paceWindows: null,
        distanceWindows: null
      };
    }

    const sortedActivities = sortActivities(activities);
    const recentRuns = getRecentRuns(sortedActivities, 28);
    const recentRuns7 = getRecentRuns(sortedActivities, 7);
    const recentRuns14 = getRecentRuns(sortedActivities, 14);
    const easyPace = estimateEasyPace(sortedActivities);

    const dist7d = recentRuns7.reduce((sum, run) => sum + (run.distance || 0), 0);
    const dist28d = recentRuns14.reduce((sum, run) => sum + (run.distance || 0), 0);
    const chronicAvg = dist28d / 4;
    const acwr = chronicAvg > 0 ? dist7d / chronicAvg : 1;

    // FIX #1: restDays previously counted unique run-days from a 7-day window
    // but subtracted from 14, guaranteeing a value >= 7 almost always. Now
    // both the run-day count and the window size are 7 days, so restDays
    // correctly ranges 0-7 and the "restDays <= 2" checks behave as intended.
    const restDays = Math.max(0, 7 - new Set(recentRuns7.map(run => Math.floor(new Date(run.date).getTime() / DAY_MS))).size);

    const lastRun = recentRuns[0];
    const daysSinceLastRun = lastRun ? getDaysBetween(lastRun.date) : 999;
    const recentHardActivities = recentRuns.filter(run => classifyRun(run, easyPace) === 'hard');
    const daysSinceLastHardWorkout = recentHardActivities.length ? getDaysBetween(recentHardActivities[0].date) : 999;
    const hardCountLast6Days = recentRuns.filter(run => classifyRun(run, easyPace) === 'hard' && getDaysBetween(run.date) <= 6).length;

    const paceTrendWindow = recentRuns.slice(0, 8);
    const earlierAvgPace = paceTrendWindow.length >= 2 ? paceTrendWindow.slice(Math.floor(paceTrendWindow.length / 2)).reduce((sum, run) => sum + (getActivityPace(run) || 0), 0) / Math.max(1, Math.ceil(paceTrendWindow.length / 2)) : 0;
    const recentAvgPace = paceTrendWindow.length >= 2 ? paceTrendWindow.slice(0, Math.ceil(paceTrendWindow.length / 2)).reduce((sum, run) => sum + (getActivityPace(run) || 0), 0) / Math.max(1, Math.floor(paceTrendWindow.length / 2)) : 0;
    const paceImprovementPct = earlierAvgPace > 0 ? ((earlierAvgPace - recentAvgPace) / earlierAvgPace) * 100 : 0;
    const performanceTrend = paceImprovementPct;

    const trainingBalance = analyzeTrainingBalance(sortedActivities, easyPace);

    // FIX #2: this metric compares only the two most recent runs' pace, which
    // is a noisy day-to-day signal, not a genuine fatigue/"collapse" indicator
    // (a single hilly or windy run can trigger it). We keep the calculation
    // but it's now weighted much more lightly downstream (see determineWorkout),
    // and only ever nudges the recommendation rather than dominating it.
    const paceCollapse = Math.max(0, Math.min(20, Math.round(
      Math.max(0, (
        (recentRuns[1] ? (getActivityPace(recentRuns[1]) || 0) : 0)
        - (recentRuns[0] ? (getActivityPace(recentRuns[0]) || 0) : 0)
      ) / Math.max(1, recentRuns[0] ? getActivityPace(recentRuns[0]) : 1) * 100)
    )));

    const metrics = {
      acwr,
      dist7d,
      dist28d,
      restDays,
      daysSinceLastRun,
      daysSinceLastHardWorkout,
      paceCollapse,
      performanceTrend
    };

    const workoutType = determineWorkout(sortedActivities, metrics, trainingBalance, easyPace);
    const avgRunDistance = recentRuns.length ? recentRuns.reduce((sum, run) => sum + run.distance, 0) / recentRuns.length : 7;
    const previousLongRun = recentRuns.filter(run => run.distance >= avgRunDistance * 1.15).slice(1, 3).reduce((best, run) => Math.max(best, run.distance), 0) || avgRunDistance;
    const distanceWindows = buildDistanceWindows(sortedActivities, workoutType, dist7d, previousLongRun, avgRunDistance, previousLongRun);
    const paceWindows = buildPaceWindows(sortedActivities, easyPace);
    const workoutLabel = workoutTypeLabels[workoutType] || workoutTypeLabels.easy;
    const workoutDistance = workoutType === 'rest' ? 0 : Math.max(0, Math.round(distanceWindows.chosen * 10) / 10);
    const paceRange = workoutType === 'rest' ? null : formatPaceRange(paceWindows[workoutType][0], paceWindows[workoutType][1]);

    const reasonLines = [];
    reasonLines.push(`ACWR is ${acwr.toFixed(2)} (${acwr > 1.2 ? 'load is elevated' : acwr < 0.9 ? 'recovery is low' : 'balanced'}).`);
    reasonLines.push(`Last workout was ${trainingBalance.categorized[0] ? trainingBalance.categorized[0].label : 'easy'} and the week sits at ${dist7d.toFixed(1)} km.`);
    reasonLines.push(`Recent pacing is ${performanceTrend >= 2 ? 'improving' : performanceTrend <= -2 ? 'slipping' : 'stable'} (${performanceTrend >= 0 ? '+' : ''}${performanceTrend.toFixed(1)}%).`);
    if (hardCountLast6Days >= 3) reasonLines.push('Three hard sessions in the last 6 days make today a good day for a lower-stress session.');
    if (daysSinceLastRun >= 3) reasonLines.push(`It has been ${daysSinceLastRun} days since your last run, so the plan prioritises freshness over extra volume.`);
    if (trainingBalance.hardRatio > 0.2) reasonLines.push('The recent balance is drifting too hard-heavy, so the engine is protecting the aerobic share.');
    if (workoutType === 'long' && previousLongRun > 0) reasonLines.push(`Long-run volume is kept within roughly 10% of your recent longest run (${previousLongRun.toFixed(1)} km).`);
    if (restDays <= 1) reasonLines.push(`You've had ${restDays} full rest day(s) in the last week, so recovery is being weighted more heavily.`);

    const warnings = [];
    if (Number(acwr) > 1.3) warnings.push('Your training load has increased sharply this week.');
    if (hardCountLast6Days >= 3) warnings.push('You have completed 3 hard sessions in the last 6 days.');
    if (Number(acwr) > 1.15 && workoutType === 'recovery') warnings.push('Consider a recovery run today.');
    if (restDays <= 1) warnings.push('You have not taken a rest day for several days.');

    const recoveryStatus = Number(acwr) > 1.35 ? 'Recovery needed' : Number(acwr) > 1.2 ? 'Watch fatigue' : 'Ready for quality work';
    const fitnessTrend = performanceTrend > 2 ? `Improving (+${performanceTrend.toFixed(1)}%)` : performanceTrend < -2 ? `Declining (${Math.abs(performanceTrend).toFixed(1)}%)` : 'Stable';
    const status = workoutType === 'rest' ? 'Recovering' : workoutType === 'recovery' ? 'Recovering' : performanceTrend > 2 ? 'Productive' : 'Balanced';

    const recommendationText = workoutType === 'rest'
      ? `${workoutLabel}`
      : `${workoutDistance.toFixed(1)} km ${workoutLabel} • ${paceRange}`;

    return {
      workoutType,
      workoutLabel,
      distance: workoutDistance,
      paceRange,
      recommendedNextRun: recommendationText,
      reason: reasonLines[0],
      explanation: reasonLines,
      warnings,
      trainingFocus: trainingFocusMap[workoutType] || 'Aerobic development',
      status,
      fitnessTrend,
      recoveryStatus,
      paceWindows,
      distanceWindows
    };
  };

  global.WorkoutRecommendationEngine = {
    recommend: buildRecommendation,
    formatPaceRange,
    formatPaceSeconds,
    formatDistance
  };
})(window);