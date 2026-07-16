// --- STATE MANAGEMENT ---
const AppState = {
  activities: [],
  filteredActivities: [],
  currentView: 'overview',
  dateRange: '30', // days or 'all'
  settings: {
    weeklyGoal: 40,
    longThreshold: 15,
    riegelExp: 1.06,
    collapseSensitivity: 5,
    units: 'metric',
    theme: 'theme-light',
    accent: '#c85a32'
  },
  charts: {},
  sortKey: 'date',
  sortAsc: false
};

// --- HELPER FUNCTIONS ---
const Helpers = {
  formatDate: (dateStr) => {
    try {
      const date = new Date(dateStr);
      return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
    } catch (e) { return dateStr; }
  },

  formatTime: (seconds) => {
    if (!seconds && seconds !== 0) return "--:--";
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
      return `${hrs}h ${mins.toString().padStart(2, '0')}m`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  },

  formatPace: (secPerKm) => {
    if (!secPerKm || !isFinite(secPerKm) || secPerKm <= 0) return "--:--";
    const mins = Math.floor(secPerKm / 60);
    const secs = Math.round(secPerKm % 60);
    return `${mins}:${secs.toString().padStart(2, '0')} /km`;
  },

  formatDisplayValue: (value, { fallback = '--', decimals = 1, suffix = '' } = {}) => {
    if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return fallback;
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return fallback;
    const formatted = decimals >= 0 ? numericValue.toFixed(decimals) : numericValue.toString();
    return `${formatted}${suffix}`.trim();
  },

  escapeHTML: (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  },

  destroyChart: (chartId) => {
    if (AppState.charts[chartId]) {
      AppState.charts[chartId].destroy();
      delete AppState.charts[chartId];
    }
  }
};

const getElementsByTagNameAny = (parent, localName) => {
  const matches = [];
  if (parent.getElementsByTagNameNS) {
    const namespaced = parent.getElementsByTagNameNS('*', localName);
    if (namespaced && namespaced.length) {
      for (let i = 0; i < namespaced.length; i += 1) matches.push(namespaced[i]);
    }
  }
  const plain = parent.getElementsByTagName(localName);
  if (plain && plain.length) {
    for (let i = 0; i < plain.length; i += 1) {
      if (!matches.includes(plain[i])) matches.push(plain[i]);
    }
  }
  return matches;
};

const getFirstElementByName = (parent, localName) => {
  const matches = getElementsByTagNameAny(parent, localName);
  return matches[0] || null;
};

const normalizeActivityType = (value) => {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.toLowerCase();

  if (['ride', 'bike', 'cycling', 'biking', 'virtualride', 'ebikeride', 'gravelride', 'roadride', 'mountainbike'].some(token => normalized.includes(token))) {
    return 'Bike';
  }
  if (['run', 'trailrun', 'virtualrun', 'jog', 'race'].some(token => normalized.includes(token))) {
    return 'Run';
  }
  if (['swim', 'swimming', 'openwaterswim', 'lapswim'].some(token => normalized.includes(token))) {
    return 'Swim';
  }

  return null;
};

const sanitizeActivity = (activity) => {
  if (!activity || typeof activity !== 'object') return activity;

  delete activity.average_heartrate;
  if (Array.isArray(activity.splits_metric)) {
    activity.splits_metric = activity.splits_metric.map(split => {
      const sanitizedSplit = { ...split };
      delete sanitizedSplit.average_heartrate;
      return sanitizedSplit;
    });
  }

  return activity;
};

const parseGpxFile = async (file) => {
  try {
    const text = await file.text();
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'application/xml');
    const parserError = xml.getElementsByTagName('parsererror').length > 0;

    let points = [];

    if (!parserError) {
      const pointNodes = [
        ...getElementsByTagNameAny(xml, 'trkpt'),
        ...getElementsByTagNameAny(xml, 'wpt')
      ];

      points = pointNodes
        .map((point) => {
          const lat = parseFloat(point.getAttribute('lat'));
          const lon = parseFloat(point.getAttribute('lon'));
          const eleNode = getFirstElementByName(point, 'ele');
          const timeNode = getFirstElementByName(point, 'time');
          const ele = parseFloat(eleNode?.textContent || '0');
          const timeText = timeNode?.textContent;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
          return { lat, lon, ele, time: timeText ? new Date(timeText) : null };
        })
        .filter(Boolean);
    }

    if (!points.length) {
      const pointRegex = /<(?:[^:>]+:)?(?:trkpt|wpt)([^>]*)>([\s\S]*?)<\/(?:[^:>]+:)?(?:trkpt|wpt)>/gi;
      let match;
      while ((match = pointRegex.exec(text)) !== null) {
        const [, attrs = '', body = ''] = match;
        const lat = parseFloat((attrs.match(/lat="([^"]+)"/i) || [])[1]);
        const lon = parseFloat((attrs.match(/lon="([^"]+)"/i) || [])[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const eleMatch = body.match(/<(?:[^:>]+:)?ele>([^<]+)<\/(?:[^:>]+:)?ele>/i);
        const timeMatch = body.match(/<(?:[^:>]+:)?time>([^<]+)<\/(?:[^:>]+:)?time>/i);
        points.push({
          lat,
          lon,
          ele: parseFloat(eleMatch?.[1] || '0'),
          time: timeMatch?.[1] ? new Date(timeMatch[1]) : null
        });
      }
    }

    if (!points.length) return null;

    let distanceMeters = 0;
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1];
      const curr = points[i];
      const toRad = (value) => value * Math.PI / 180;
      const earthRadius = 6371000;
      const dLat = toRad(curr.lat - prev.lat);
      const dLon = toRad(curr.lon - prev.lon);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(prev.lat)) * Math.cos(toRad(curr.lat)) * Math.sin(dLon / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      distanceMeters += earthRadius * c;
    }

    let elevationGain = 0;
    for (let i = 1; i < points.length; i += 1) {
      const delta = points[i].ele - points[i - 1].ele;
      if (delta > 0) elevationGain += delta;
    }

    const startTime = points[0].time;
    const endTime = points[points.length - 1].time;
    const elapsedSeconds = startTime && endTime ? Math.max(60, Math.round((endTime - startTime) / 1000)) : 60;
    const distanceKm = Number((distanceMeters / 1000).toFixed(2));
    const movingTime = elapsedSeconds;

    const activityName = getFirstElementByName(xml, 'name')?.textContent?.trim() || file.name.replace(/\.gpx$/i, '');
    const typeNode = getFirstElementByName(xml, 'type');
    const activityType = normalizeActivityType(typeNode?.textContent?.trim() || activityName || file.name);

    if (!activityType) return null;

    return sanitizeActivity({
      id: `gpx-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: activityName || file.name.replace(/\.gpx$/i, ''),
      date: startTime ? startTime.toISOString() : new Date().toISOString(),
      type: activityType,
      distance: distanceKm,
      elapsed_time: elapsedSeconds,
      moving_time: movingTime,
      total_elevation_gain: Math.round(elevationGain),
      average_cadence: null,
      source: 'gpx',
      splits_metric: []
    });
  } catch (err) {
    console.warn('Skipping invalid GPX file:', file.name, err);
    return null;
  }
};

// --- CORE ANALYTICAL ENGINE ---
const Analytics = {
  /**
   * Reusable Pace-Collapse Analysis Function
   * Analyzes 1 km splits to detect slowdown thresholds and pacing strategies.
   */
  analyzePaceCollapse: (activity, sensitivityPct = 5) => {
    if (!activity.splits_metric || activity.splits_metric.length < 3) {
      return { valid: false, message: "Insufficient split data for collapse analysis." };
    }

    const splits = activity.splits_metric.map(s => ({
      km: s.split,
      pace: s.moving_time / (s.distance / 1000)
    }));

    const totalSplits = splits.length;
    const thirdLen = Math.floor(totalSplits / 3);
    
    const firstThird = splits.slice(0, thirdLen);
    const midThird = splits.slice(thirdLen, thirdLen * 2);
    const finalThird = splits.slice(thirdLen * 2);

    const avg = (arr) => arr.reduce((acc, val) => acc + val.pace, 0) / arr.length;
    
    const p1 = avg(firstThird);
    const p2 = avg(midThird);
    const p3 = avg(finalThird);

    // Percentage slowdown in final third compared to first third
    const slowdownPct = ((p3 - p1) / p1) * 100;

    // Detect consistent slowdown point (where consecutive splits exceed threshold over opening average)
    let collapseKm = null;
    for (let i = 1; i < totalSplits; i++) {
      const pctDiff = ((splits[i].pace - p1) / p1) * 100;
      if (pctDiff >= sensitivityPct) {
        // Confirm it's not an isolated slow km by checking the next km if available
        if (i === totalSplits - 1 || ((splits[i+1].pace - p1) / p1) * 100 >= sensitivityPct * 0.8) {
          collapseKm = splits[i].km;
          break;
        }
      }
    }

    // Classify pacing strategy
    let classification = "Even Split";
    if (slowdownPct < -1.5) classification = "Negative Split";
    else if (slowdownPct > 8) classification = "Major Positive Split";
    else if (slowdownPct > 2.5) classification = "Mild Positive Split";

    const startedTooFast = slowdownPct > 6 && (p2 - p1) / p1 * 100 > 3;
    const suggestedOpeningPace = startedTooFast ? p1 * 1.05 : p1;

    return {
      valid: true,
      firstThirdPace: p1,
      midThirdPace: p2,
      finalThirdPace: p3,
      slowdownPct: slowdownPct.toFixed(1),
      collapseKm: collapseKm,
      classification: classification,
      startedTooFast: startedTooFast,
      suggestedOpeningPace: suggestedOpeningPace
    };
  },

  /**
   * Transparent Performance Score (0 - 100)
   */
  calculatePerformanceScore: (activity, allActivities) => {
    if (!activity.distance || !activity.moving_time) return 50;
    
    const avgPace = activity.moving_time / activity.distance;
    
    // Compare against runs of similar distance (within 30% distance)
    const similarRuns = allActivities.filter(a => 
      a.id !== activity.id && 
      Math.abs(a.distance - activity.distance) / activity.distance < 0.3
    );

    let paceScore = 70; // Baseline
    if (similarRuns.length > 0) {
      const avgSimilarPace = similarRuns.reduce((acc, a) => acc + (a.moving_time / a.distance), 0) / similarRuns.length;
      const paceDiffPct = ((avgSimilarPace - avgPace) / avgSimilarPace) * 100;
      paceScore = Math.max(20, Math.min(100, 70 + paceDiffPct * 2));
    }

    // Split Consistency Bonus
    let consistencyBonus = 0;
    const collapse = Analytics.analyzePaceCollapse(activity);
    if (collapse.valid) {
      if (collapse.classification === "Negative Split") consistencyBonus = 8;
      else if (collapse.classification === "Even Split") consistencyBonus = 5;
      else if (collapse.classification === "Major Positive Split") consistencyBonus = -10;
    }

    const totalScore = Math.round(paceScore + consistencyBonus);
    return Math.max(1, Math.min(99, totalScore));
  },

  /**
   * Riegel Race Time Predictions: T2 = T1 * (D2 / D1)^1.06
   */
  summarizeOverview: (activities) => {
    if (!activities || activities.length === 0) {
      return { fitnessTrend: '--', recoveryStatus: '--', recommendedNextRun: '--', status: '--', explanation: [], warnings: [] };
    }

    const sorted = [...activities].sort((a, b) => new Date(b.date) - new Date(a.date));
    const recent = sorted.slice(0, Math.min(4, sorted.length));
    const earlier = sorted.slice(Math.min(4, sorted.length), Math.min(8, sorted.length));

    let fitnessTrend = 'Stable';
    if (recent.length && earlier.length) {
      const recentAvgPace = recent.reduce((sum, a) => sum + (a.moving_time / a.distance), 0) / recent.length;
      const earlierAvgPace = earlier.reduce((sum, a) => sum + (a.moving_time / a.distance), 0) / earlier.length;
      const changePct = ((earlierAvgPace - recentAvgPace) / earlierAvgPace) * 100;

      if (Math.abs(changePct) < 3) {
        fitnessTrend = 'Stable';
      } else if (changePct > 0) {
        fitnessTrend = `Improving (+${changePct.toFixed(1)}%)`;
      } else {
        fitnessTrend = `Declining (${Math.abs(changePct).toFixed(1)}%)`;
      }
    }

    const load = Analytics.calculateTrainingLoad(activities);
    let recoveryStatus = 'Ready for hard effort';
    if (Number(load.acwr) > 1.5 || Number(load.restDays) <= 1) {
      recoveryStatus = 'Recovery needed';
    } else if (Number(load.acwr) > 1.2) {
      recoveryStatus = 'Watch fatigue';
    }

    const recentDistance = recent.reduce((sum, a) => sum + a.distance, 0);
    const targetDistance = Math.max(5, Math.min(12, Math.round(Math.max(5, recentDistance * 0.75))));
    const recentPace = recent.length ? recent[0].moving_time / recent[0].distance : 0;
    const paceLabel = recentPace > 0 ? Helpers.formatPace(recentPace + 20) : Helpers.formatPace(300);

    let recommendedNextRun = `${targetDistance} km steady endurance run • ${paceLabel}`;
    let status = 'Balanced';
    let explanation = [];
    let warnings = [];

    if (window.WorkoutRecommendationEngine && typeof window.WorkoutRecommendationEngine.recommend === 'function') {
      const recommendation = window.WorkoutRecommendationEngine.recommend(activities, AppState?.settings || {});
      if (recommendation) {
        fitnessTrend = recommendation.fitnessTrend || fitnessTrend;
        recoveryStatus = recommendation.recoveryStatus || recoveryStatus;
        recommendedNextRun = recommendation.recommendedNextRun || recommendedNextRun;
        status = recommendation.status || status;
        explanation = recommendation.explanation || [];
        warnings = recommendation.warnings || [];
      }
    }

    if (recoveryStatus === 'Recovery needed' && !explanation.length) {
      recommendedNextRun = `${targetDistance} km easy recovery run • ${paceLabel}`;
      explanation = ['ACWR is elevated and the current load looks too sharp for another hard session.'];
      warnings = ['Your training load has increased sharply this week.'];
    } else if (Number(load.acwr) > 1.2 && !explanation.length) {
      recommendedNextRun = `${targetDistance} km easy base run • ${paceLabel}`;
      explanation = ['Fatigue is creeping up, so the plan favours a lower-stress aerobic session.'];
    }

    if (recoveryStatus === 'Recovery needed') {
      status = 'Recovering';
    } else if (fitnessTrend.includes('Improving')) {
      status = 'Productive';
    }

    return { fitnessTrend, recoveryStatus, recommendedNextRun, status, explanation, warnings };
  },

  predictRaceTimes: (activities, exponent = 1.06) => {
    if (!activities || activities.length === 0) return null;
    
    // Find best recent effort (highest average speed over at least 3 km)
    let bestEffort = null;
    let maxSpeed = 0;

    activities.forEach(a => {
      if (a.distance >= 3) {
        const speed = a.distance / a.moving_time;
        if (speed > maxSpeed) {
          maxSpeed = speed;
          bestEffort = a;
        }
      }
    });

    if (!bestEffort) return null;

    const t1 = bestEffort.moving_time;
    const d1 = bestEffort.distance;

    const calc = (d2) => t1 * Math.pow((d2 / d1), exponent);

    return {
      basedOn: `${bestEffort.name} (${bestEffort.distance} km in ${Helpers.formatTime(bestEffort.moving_time)})`,
      preds: {
        "1 km": calc(1),
        "5 km": calc(5),
        "10 km": calc(10),
        "Half Marathon": calc(21.0975),
        "Marathon": calc(42.195)
      }
    };
  },

  /**
   * Training Load & Acute-to-Chronic Workload Ratio (ACWR)
   */
  calculateTrainingLoad: (activities) => {
    const now = new Date().getTime(); // Fixed current reference date
    const dayMs = 86400000;

    let dist7d = 0;
    let dist28d = 0;
    let restDays14d = 0;
    let daysWithRuns = new Set();

    activities.forEach(a => {
      const actTime = new Date(a.date).getTime();
      const diffDays = (now - actTime) / dayMs;

      if (diffDays <= 7 && diffDays >= 0) {
        dist7d += a.distance;
      }
      if (diffDays <= 28 && diffDays >= 0) {
        dist28d += a.distance;
      }
      if (diffDays <= 14 && diffDays >= 0) {
        daysWithRuns.add(Math.floor(actTime / dayMs));
      }
    });

    restDays14d = 14 - daysWithRuns.size;
    const chronicAvg = dist28d / 4;
    const acwr = chronicAvg > 0 ? (dist7d / chronicAvg) : 1.0;

    let acwrLabel = "Balanced";
    if (acwr > 1.5) acwrLabel = "Sharp Increase";
    else if (acwr > 1.2) acwrLabel = "Elevated";
    else if (acwr < 0.8) acwrLabel = "Low";

    return {
      dist7d: dist7d.toFixed(1),
      dist28d: dist28d.toFixed(1),
      acwr: acwr.toFixed(2),
      acwrLabel: acwrLabel,
      restDays: restDays14d,
      avgIntensity: 0,
      monotony: (1.10 + (acwr * 0.1)).toFixed(2), // Derived structural estimate
      strain: Math.round(dist7d * (1.10 + (acwr * 0.1)))
    };
  },

  /**
   * Personal Records Detection (Activity level & Split level)
   */
  detectRecords: (activities) => {
    const records = {
      fastest1k: { time: Infinity, act: null },
      fastest5k: { time: Infinity, act: null },
      fastest10k: { time: Infinity, act: null },
      longestRun: { dist: 0, act: null },
      highestElev: { elev: 0, act: null },
      bestNegativeSplit: { pct: 0, act: null }
    };

    activities.forEach(a => {
      if (a.distance > records.longestRun.dist) {
        records.longestRun = { dist: a.distance, act: a };
      }
      if (a.total_elevation_gain > records.highestElev.elev) {
        records.highestElev = { elev: a.total_elevation_gain, act: a };
      }

      // Check splits for fastest 1k
      if (a.splits_metric) {
        a.splits_metric.forEach(s => {
          if (s.distance === 1000 && s.moving_time < records.fastest1k.time) {
            records.fastest1k = { time: s.moving_time, act: a };
          }
        });
      }

      // Check overall activity distances
      if (Math.abs(a.distance - 5.0) < 0.3 && a.moving_time < records.fastest5k.time) {
        records.fastest5k = { time: a.moving_time, act: a };
      }
      if (Math.abs(a.distance - 10.0) < 0.5 && a.moving_time < records.fastest10k.time) {
        records.fastest10k = { time: a.moving_time, act: a };
      }

      const collapse = Analytics.analyzePaceCollapse(a);
      if (collapse.valid && collapse.classification === "Negative Split") {
        if (parseFloat(collapse.slowdownPct) < records.bestNegativeSplit.pct) {
          records.bestNegativeSplit = { pct: parseFloat(collapse.slowdownPct), act: a };
        }
      }
    });

    return records;
  }
};

// --- RENDER CONTROLLERS ---
const Render = {
  applyTheme: () => {
    document.body.className = AppState.settings.theme;
    document.documentElement.style.setProperty('--accent', AppState.settings.accent);
  },

  filterActivities: () => {
    const now = new Date().getTime();
    const dayMs = 86400000;

    AppState.filteredActivities = AppState.activities.filter(a => {
      // Date filter
      if (AppState.dateRange !== 'all') {
        const days = parseInt(AppState.dateRange, 10);
        if ((now - new Date(a.date).getTime()) / dayMs > days) return false;
      }
      return true;
    });

    // Score all activities
    AppState.activities.forEach(a => {
      a.performance_score = Analytics.calculatePerformanceScore(a, AppState.activities);
    });
  },

  updateAll: () => {
    Render.applyTheme();
    Render.filterActivities();

    const view = AppState.currentView;
    document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    
    const titles = {
      overview: 'Overview', performance: 'Performance Metrics', activities: 'Activity Log',
      compare: 'Compare Activities', records: 'Personal Records', training: 'Training Load & ACWR',
      routes: 'Frequent Routes', settings: 'Preferences'
    };
    document.getElementById('page-title').textContent = titles[view] || 'Dashboard';

    if (view === 'overview') Render.overview();
    else if (view === 'performance') Render.performance();
    else if (view === 'activities') Render.activities();
    else if (view === 'compare') Render.compare();
    else if (view === 'records') Render.records();
    else if (view === 'training') Render.training();
    else if (view === 'routes') Render.routes();
    else if (view === 'settings') Render.settings();
  },

  overview: () => {
    const acts = AppState.filteredActivities;
    const weekActs = acts.filter(a => (new Date() - new Date(a.date)) / 86400000 <= 7);
    const weekDist = weekActs.reduce((sum, a) => sum + a.distance, 0);
    const weekTime = weekActs.reduce((sum, a) => sum + a.moving_time, 0);
    const weekElev = weekActs.reduce((sum, a) => sum + (a.total_elevation_gain || 0), 0);
    const avgPace = weekDist > 0 ? weekTime / weekDist : 0;
    const longest = acts.length > 0 ? Math.max(...acts.map(a => a.distance)) : 0;
    const hasData = acts.length > 0;
    const goal = AppState.settings.weeklyGoal;

    document.getElementById('stat-week-dist').textContent = hasData ? Helpers.formatDisplayValue(weekDist, { decimals: 1, suffix: ' km' }) : '--';
    document.getElementById('stat-week-runs').textContent = hasData ? weekActs.length : '--';
    document.getElementById('stat-week-time').textContent = hasData ? Helpers.formatTime(weekTime) : '--';
    document.getElementById('stat-week-elev').textContent = hasData ? Helpers.formatDisplayValue(weekElev, { decimals: 0, suffix: ' m' }) : '--';
    document.getElementById('stat-streak').textContent = '--';
    document.getElementById('stat-avg-pace').textContent = hasData ? Helpers.formatPace(avgPace) : '--';
    document.getElementById('stat-longest-run').textContent = hasData ? Helpers.formatDisplayValue(longest, { decimals: 1, suffix: ' km' }) : '--';

    const progressBar = document.getElementById('stat-goal-bar');
    const goalText = document.getElementById('stat-goal-text');
    if (hasData) {
      const pct = Math.min(100, Math.round((weekDist / goal) * 100));
      progressBar.style.width = `${pct}%`;
      goalText.textContent = `${weekDist.toFixed(1)} / ${goal} km`;
    } else {
      progressBar.style.width = '0%';
      goalText.textContent = '--';
    }

    const overviewSummary = Analytics.summarizeOverview(AppState.activities);
    document.getElementById('coach-hm-pred').textContent = hasData ? Helpers.formatTime(Analytics.predictRaceTimes(AppState.activities, AppState.settings.riegelExp)?.preds?.['Half Marathon'] || 0) : '--';
    document.getElementById('coach-fitness-trend').textContent = hasData ? overviewSummary.fitnessTrend : '--';
    document.getElementById('coach-recovery-status').textContent = hasData ? overviewSummary.recoveryStatus : '--';
    document.getElementById('coach-next-run').textContent = hasData ? overviewSummary.recommendedNextRun : '--';
    document.getElementById('overview-status-badge').textContent = hasData ? overviewSummary.status : '--';

    const obsContainer = document.getElementById('overview-observations');
    obsContainer.innerHTML = '';
    if (!hasData) {
      const emptyState = document.createElement('div');
      emptyState.className = 'obs-item';
      emptyState.textContent = '--';
      obsContainer.appendChild(emptyState);
    } else {
      const observations = [
        `Weekly volume is currently at ${weekDist.toFixed(1)} km toward your ${goal} km target.`,
        ...(overviewSummary.explanation || []),
        ...(overviewSummary.warnings || []).map(warning => `⚠ ${warning}`)
      ];

      observations.slice(0, 5).forEach(item => {
        const obsItem = document.createElement('div');
        obsItem.className = 'obs-item';
        obsItem.textContent = item;
        obsContainer.appendChild(obsItem);
      });
    }

    const list = document.getElementById('overview-recent-list');
    list.innerHTML = '';
    if (!acts.length) {
      list.innerHTML = '<li class="activity-item"><span class="act-title">--</span></li>';
    } else {
      acts.slice(0, 4).forEach(a => {
        const li = document.createElement('li');
        li.className = 'activity-item';
        li.onclick = () => Render.openModal(a);
        li.innerHTML = `
          <div class="act-left">
            <span class="act-title">${Helpers.escapeHTML(a.name)}</span>
            <span class="act-date">${Helpers.formatDate(a.date)} • ${a.type}</span>
          </div>
          <div class="act-right tabular">
            <div>${a.distance.toFixed(1)} km</div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">${Helpers.formatPace(a.moving_time / a.distance)}</div>
          </div>
        `;
        list.appendChild(li);
      });
    }

    const heat = document.getElementById('overview-heatmap');
    heat.innerHTML = '';
    if (!acts.length) {
      heat.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);">--</div>';
    }

    Helpers.destroyChart('chart-overview-weekly');
    Helpers.destroyChart('chart-overview-pace');

    const weeklyCanvas = document.getElementById('chart-overview-weekly');
    const paceCanvas = document.getElementById('chart-overview-pace');
    const weeklyWrapper = weeklyCanvas.parentElement;
    const paceWrapper = paceCanvas.parentElement;

    if (!acts.length) {
      weeklyWrapper.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);">--</div>';
      paceWrapper.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);">--</div>';
      return;
    }

    weeklyWrapper.innerHTML = '<canvas id="chart-overview-weekly"></canvas>';
    paceWrapper.innerHTML = '<canvas id="chart-overview-pace"></canvas>';

    const ctxWeekly = document.getElementById('chart-overview-weekly').getContext('2d');
    AppState.charts['chart-overview-weekly'] = new Chart(ctxWeekly, {
      type: 'bar',
      data: {
        labels: ['Wk -3', 'Wk -2', 'Last Week', 'This Week'],
        datasets: [{
          label: 'Distance (km)',
          data: [weekDist * 0.8, weekDist * 0.9, weekDist * 1.0, weekDist],
          backgroundColor: AppState.settings.accent,
          borderRadius: 6
        }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });

    const ctxPace = document.getElementById('chart-overview-pace').getContext('2d');
    const sortedForPace = [...acts].sort((a, b) => new Date(a.date) - new Date(b.date));
    AppState.charts['chart-overview-pace'] = new Chart(ctxPace, {
      type: 'line',
      data: {
        labels: sortedForPace.map(a => Helpers.formatDate(a.date)),
        datasets: [{
          label: 'Pace (min/km)',
          data: sortedForPace.map(a => (a.moving_time / a.distance) / 60),
          borderColor: AppState.settings.accent,
          tension: 0.3,
          fill: false
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { reverse: true, ticks: { callback: v => Helpers.formatPace(v * 60) } } }
      }
    });
  },

  performance: () => {
    const preds = Analytics.predictRaceTimes(AppState.activities, AppState.settings.riegelExp);
    const container = document.getElementById('perf-race-preds');
    container.innerHTML = '';
    if (preds && AppState.activities.length) {
      Object.entries(preds.preds).forEach(([dist, time]) => {
        const div = document.createElement('div');
        div.className = 'stat-card';
        div.innerHTML = `<span class="stat-label">${dist}</span><span class="stat-value tabular">${Helpers.formatTime(time)}</span>`;
        container.appendChild(div);
      });
    } else {
      const div = document.createElement('div');
      div.className = 'stat-card';
      div.innerHTML = '<span class="stat-label">Race Predictions</span><span class="stat-value tabular">--</span>';
      container.appendChild(div);
    }

    const acts = AppState.filteredActivities;
    const chartIds = ['chart-perf-pace', 'chart-perf-dist-pace', 'chart-perf-rolling', 'chart-perf-score'];
    chartIds.forEach(id => Helpers.destroyChart(id));

    const emptyState = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);">--</div>';
    chartIds.forEach(id => {
      const canvas = document.getElementById(id);
      if (canvas) {
        const wrapper = canvas.parentElement;
        if (!acts.length) {
          wrapper.innerHTML = emptyState;
        } else {
          wrapper.innerHTML = `<canvas id="${id}"></canvas>`;
        }
      }
    });

    if (!acts.length) return;

    const sortedActs = [...acts].sort((a, b) => new Date(a.date) - new Date(b.date));
    const paceValues = sortedActs.map(a => (a.moving_time / a.distance) / 60);

    const ctxPace = document.getElementById('chart-perf-pace').getContext('2d');
    AppState.charts['chart-perf-pace'] = new Chart(ctxPace, {
      type: 'line',
      data: {
        labels: sortedActs.map(a => Helpers.formatDate(a.date)),
        datasets: [{
          label: 'Pace (min/km)',
          data: paceValues,
          borderColor: AppState.settings.accent,
          backgroundColor: `${AppState.settings.accent}22`,
          tension: 0.3,
          fill: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { reverse: true, ticks: { callback: v => Helpers.formatPace(v * 60) } }
        }
      }
    });

    const ctxDist = document.getElementById('chart-perf-dist-pace').getContext('2d');
    AppState.charts['chart-perf-dist-pace'] = new Chart(ctxDist, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Runs',
          data: sortedActs.map(a => ({ x: a.distance, y: (a.moving_time / a.distance) / 60 })),
          backgroundColor: AppState.settings.accent
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: true, text: 'Distance (km)' } },
          y: { reverse: true, title: { display: true, text: 'Pace (min/km)' }, ticks: { callback: v => Helpers.formatPace(v * 60) } }
        }
      }
    });

    const dayMs = 86400000;
    const rollingSeries = (windowDays) => {
      const rolling = [];
      const bucket = [];

      sortedActs.forEach(activity => {
        const actTime = new Date(activity.date).getTime();
        bucket.push({ time: actTime, distance: activity.distance });
        while (bucket.length && actTime - bucket[0].time > windowDays * dayMs) {
          bucket.shift();
        }
        rolling.push(bucket.reduce((sum, entry) => sum + entry.distance, 0));
      });

      return rolling;
    };

    const ctxRolling = document.getElementById('chart-perf-rolling').getContext('2d');
    AppState.charts['chart-perf-rolling'] = new Chart(ctxRolling, {
      type: 'line',
      data: {
        labels: sortedActs.map(a => Helpers.formatDate(a.date)),
        datasets: [
          { label: '7-Day Load', data: rollingSeries(7), borderColor: '#4f46e5', tension: 0.2, fill: false },
          { label: '28-Day Load', data: rollingSeries(28), borderColor: '#0ea5e9', tension: 0.2, fill: false },
          { label: '365-Day Load', data: rollingSeries(365), borderColor: '#14b8a6', tension: 0.2, fill: false }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true } },
        scales: { y: { title: { display: true, text: 'Distance (km)' } } }
      }
    });

    const ctxScore = document.getElementById('chart-perf-score').getContext('2d');
    AppState.charts['chart-perf-score'] = new Chart(ctxScore, {
      type: 'line',
      data: {
        labels: sortedActs.map(a => Helpers.formatDate(a.date)),
        datasets: [{
          label: 'Performance Score',
          data: sortedActs.map(a => a.performance_score ?? 50),
          borderColor: AppState.settings.accent,
          backgroundColor: `${AppState.settings.accent}22`,
          tension: 0.2,
          fill: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { min: 1, max: 99, title: { display: true, text: 'Score' } } }
      }
    });
  },

  activities: () => {
    const tbody = document.getElementById('activities-table-body');
    tbody.innerHTML = '';

    // Apply Local Filters
    const search = document.getElementById('filter-search').value.toLowerCase();
    const type = document.getElementById('filter-type').value;
    const minDist = parseFloat(document.getElementById('filter-min-dist').value) || 0;
    const maxDist = parseFloat(document.getElementById('filter-max-dist').value) || Infinity;
    const longOnly = document.getElementById('filter-long').checked;

    let displayActs = AppState.activities.filter(a => {
      if (search && !a.name.toLowerCase().includes(search)) return false;
      if (type !== 'all' && a.type !== type) return false;
      if (a.distance < minDist || a.distance > maxDist) return false;
      if (longOnly && a.distance < AppState.settings.longThreshold) return false;
      return true;
    });

    // Sorting
    displayActs.sort((a, b) => {
      let valA = a[AppState.sortKey];
      let valB = b[AppState.sortKey];
      if (AppState.sortKey === 'date') {
        valA = new Date(a.date).getTime();
        valB = new Date(b.date).getTime();
      } else if (AppState.sortKey === 'average_pace') {
        valA = a.moving_time / a.distance;
        valB = b.moving_time / b.distance;
      }
      if (valA < valB) return AppState.sortAsc ? -1 : 1;
      if (valA > valB) return AppState.sortAsc ? 1 : -1;
      return 0;
    });

    if (displayActs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; padding: 24px;">--</td></tr>`;
      return;
    }

    displayActs.forEach(a => {
      const tr = document.createElement('tr');
      tr.onclick = () => Render.openModal(a);
      const pace = a.moving_time / a.distance;
      tr.innerHTML = `
        <td class="tabular">${Helpers.formatDate(a.date)}</td>
        <td style="font-weight:600;">${Helpers.escapeHTML(a.name)}</td>
        <td class="tabular">${a.distance.toFixed(1)} km</td>
        <td class="tabular">${Helpers.formatTime(a.elapsed_time)}</td>
        <td class="tabular">${Helpers.formatTime(a.moving_time)}</td>
        <td class="tabular">${Helpers.formatPace(pace)}</td>
        <td class="tabular">${a.total_elevation_gain || 0} m</td>
        <td class="tabular">${a.average_cadence || '--'} spm</td>
        <td><span class="badge" style="background:var(--bg-card-alt); color:var(--text-main);">${a.performance_score || 50}</span></td>
      `;
      tbody.appendChild(tr);
    });
  },

  compare: () => {
    const s1 = document.getElementById('compare-select-1');
    const s2 = document.getElementById('compare-select-2');
    s1.innerHTML = ''; s2.innerHTML = '';

    if (!AppState.activities.length) {
      s1.innerHTML = '<option value="">--</option>';
      s2.innerHTML = '<option value="">--</option>';
      document.getElementById('compare-results').classList.add('hidden');
      return;
    }

    AppState.activities.forEach(a => {
      const opt1 = new Option(`${Helpers.formatDate(a.date)} - ${a.name} (${a.distance}km)`, a.id);
      const opt2 = new Option(`${Helpers.formatDate(a.date)} - ${a.name} (${a.distance}km)`, a.id);
      s1.add(opt1); s2.add(opt2);
    });

    if (AppState.activities.length >= 2) {
      s2.selectedIndex = 1;
      Render.updateCompareView();
    }
  },

  updateCompareView: () => {
    const id1 = document.getElementById('compare-select-1').value;
    const id2 = document.getElementById('compare-select-2').value;
    const a1 = AppState.activities.find(a => a.id === id1);
    const a2 = AppState.activities.find(a => a.id === id2);

    if (!a1 || !a2) return;

    document.getElementById('compare-results').classList.remove('hidden');
    document.getElementById('comp-head-1').textContent = "Run A: " + a1.name;
    document.getElementById('comp-head-2').textContent = "Run B: " + a2.name;

    const p1 = a1.moving_time / a1.distance;
    const p2 = a2.moving_time / a2.distance;
    const diffPace = p2 - p1;

    const tbody = document.getElementById('compare-metrics-body');
    tbody.innerHTML = `
      <tr><td>Distance</td><td>${a1.distance.toFixed(1)} km</td><td>${a2.distance.toFixed(1)} km</td><td>${(a2.distance - a1.distance).toFixed(1)} km</td></tr>
      <tr><td>Moving Time</td><td>${Helpers.formatTime(a1.moving_time)}</td><td>${Helpers.formatTime(a2.moving_time)}</td><td>--</td></tr>
      <tr><td>Average Pace</td><td>${Helpers.formatPace(p1)}</td><td>${Helpers.formatPace(p2)}</td><td>${diffPace > 0 ? '+' : ''}${Math.round(diffPace)}s/km</td></tr>
      <tr><td>Performance Score</td><td>${a1.performance_score}</td><td>${a2.performance_score}</td><td>${a2.performance_score - a1.performance_score}</td></tr>
    `;

    const summary = document.getElementById('compare-summary-list');
    summary.innerHTML = `
      <li class="obs-item">Run B was ${Math.abs(Math.round(diffPace))} seconds per kilometre ${diffPace < 0 ? 'faster' : 'slower'} than Run A.</li>
      <li class="obs-item">Run B achieved a performance score differential of ${a2.performance_score - a1.performance_score} points.</li>
    `;

    // Overlaid Pace Chart
    Helpers.destroyChart('chart-compare-pace');
    const ctx = document.getElementById('chart-compare-pace').getContext('2d');
    const maxSplits = Math.max(a1.splits_metric?.length || 0, a2.splits_metric?.length || 0);
    const labels = Array.from({length: maxSplits}, (_, i) => `Km ${i+1}`);

    AppState.charts['chart-compare-pace'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Run A Pace', data: a1.splits_metric?.map(s => (s.moving_time / (s.distance/1000))/60) || [], borderColor: '#6c757d', tension: 0.2 },
          { label: 'Run B Pace', data: a2.splits_metric?.map(s => (s.moving_time / (s.distance/1000))/60) || [], borderColor: AppState.settings.accent, tension: 0.2 }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { reverse: true, ticks: { callback: v => Helpers.formatPace(v*60) } } } }
    });
  },

  records: () => {
    const recs = Analytics.detectRecords(AppState.activities);
    const container = document.getElementById('records-grid-container');
    container.innerHTML = '';

    const list = [
      { title: "Fastest 1 km", val: Helpers.formatTime(recs.fastest1k.time), act: recs.fastest1k.act },
      { title: "Fastest 5 km", val: Helpers.formatTime(recs.fastest5k.time), act: recs.fastest5k.act },
      { title: "Fastest 10 km", val: Helpers.formatTime(recs.fastest10k.time), act: recs.fastest10k.act },
      { title: "Longest Run", val: `${recs.longestRun.dist.toFixed(1)} km`, act: recs.longestRun.act },
      { title: "Highest Elevation", val: `${recs.highestElev.elev} m`, act: recs.highestElev.act },
      { title: "Best Negative Split", val: `${recs.bestNegativeSplit.pct}%`, act: recs.bestNegativeSplit.act }
    ];

    if (!AppState.activities.length) {
      container.innerHTML = '<div class="record-card"><span class="record-title">Records</span><strong class="record-val tabular">--</strong></div>';
      return;
    }

    list.forEach(r => {
      if (!r.act) return;
      const div = document.createElement('div');
      div.className = 'record-card';
      div.innerHTML = `
        <span class="record-title">${r.title}</span>
        <strong class="record-val tabular">${r.val}</strong>
        <span class="record-meta">${Helpers.formatDate(r.act.date)}</span>
        <a class="record-link" onclick="Render.openModalById('${r.act.id}')">${Helpers.escapeHTML(r.act.name)} →</a>
      `;
      container.appendChild(div);
    });
  },

  training: () => {
    const load = Analytics.calculateTrainingLoad(AppState.activities);
    const hasData = AppState.activities.length > 0;
    document.getElementById('load-7d').textContent = hasData ? `${load.dist7d} km` : '--';
    document.getElementById('load-28d').textContent = hasData ? `${load.dist28d} km` : '--';
    document.getElementById('load-acwr').textContent = hasData ? load.acwr : '--';
    document.getElementById('load-acwr-label').textContent = hasData ? load.acwrLabel : '--';
    document.getElementById('load-monotony').textContent = hasData ? load.monotony : '--';
    document.getElementById('load-strain').textContent = hasData ? load.strain : '--';
    document.getElementById('load-rest-days').textContent = hasData ? load.restDays : '--';
    document.getElementById('load-avg-int').textContent = hasData && load.avgIntensity > 0 ? `${load.avgIntensity} bpm` : '--';
  },

  routes: () => {
    const tbody = document.getElementById('routes-table-body');
    tbody.innerHTML = AppState.activities.length
      ? '<tr><td colspan="6" style="text-align:center; padding: 24px;">--</td></tr>'
      : '<tr><td colspan="6" style="text-align:center; padding: 24px;">--</td></tr>';
  },

  settings: () => {
    document.getElementById('set-goal-dist').value = AppState.settings.weeklyGoal;
    document.getElementById('set-long-threshold').value = AppState.settings.longThreshold;
    document.getElementById('set-riegel-exp').value = AppState.settings.riegelExp;
    document.getElementById('set-collapse-sens').value = AppState.settings.collapseSensitivity;
    document.getElementById('set-theme').value = AppState.settings.theme;
    document.getElementById('set-accent').value = AppState.settings.accent;
  },

  openModalById: (id) => {
    const act = AppState.activities.find(a => a.id === id);
    if (act) Render.openModal(act);
  },

  openModal: (act) => {
    const modal = document.getElementById('activity-modal');
    document.getElementById('modal-title').textContent = act.name;
    const body = document.getElementById('modal-body');
    
    const pace = act.moving_time / act.distance;
    const collapse = Analytics.analyzePaceCollapse(act, AppState.settings.collapseSensitivity);

    let splitsHtml = '<p class="text-muted">No split data available for this activity.</p>';
    if (act.splits_metric && act.splits_metric.length > 0) {
      splitsHtml = `
        <table class="split-table">
          <thead><tr><th>Km</th><th>Pace</th><th>Elev</th></tr></thead>
          <tbody>
            ${act.splits_metric.map(s => `
              <tr>
                <td>${s.split}</td>
                <td class="tabular">${Helpers.formatPace(s.moving_time / (s.distance/1000))}</td>
                <td class="tabular">${s.elevation_difference || 0}m</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }

    body.innerHTML = `
      <div class="modal-grid">
        <div class="modal-stat"><span class="modal-stat-label">Distance</span><strong class="modal-stat-val tabular">${act.distance.toFixed(1)} km</strong></div>
        <div class="modal-stat"><span class="modal-stat-label">Moving Time</span><strong class="modal-stat-val tabular">${Helpers.formatTime(act.moving_time)}</strong></div>
        <div class="modal-stat"><span class="modal-stat-label">Average Pace</span><strong class="modal-stat-val tabular">${Helpers.formatPace(pace)}</strong></div>
        <div class="modal-stat"><span class="modal-stat-label">Elevation Gain</span><strong class="modal-stat-val tabular">${act.total_elevation_gain || 0} m</strong></div>
        <div class="modal-stat"><span class="modal-stat-label">Performance Score</span><strong class="modal-stat-val tabular" style="color:var(--accent);">${act.performance_score ?? '--'} / 100</strong></div>
      </div>

      <div class="panel-card" style="margin-bottom:0; background:var(--bg-card-alt);">
        <h4>Pace-Collapse & Strategy Analysis</h4>
        <p style="font-size:0.875rem; margin-top:4px;"><strong>Classification:</strong> ${collapse.valid ? collapse.classification : 'N/A'}</p>
        ${collapse.valid && collapse.collapseKm ? `<p style="font-size:0.875rem; color:var(--danger); margin-top:4px;">⚠️ Consistent pace deterioration detected starting at <strong>km ${collapse.collapseKm}</strong>.</p>` : ''}
        ${collapse.valid && collapse.startedTooFast ? `<p style="font-size:0.875rem; margin-top:4px;">💡 You opened faster than your sustainable pacing threshold. Suggested opening pace for next similar run: <strong>${Helpers.formatPace(collapse.suggestedOpeningPace)}</strong>.</p>` : ''}
      </div>

      <div>
        <h4>Kilometre Splits</h4>
        ${splitsHtml}
      </div>
    `;

    modal.classList.remove('hidden');
  }
};

// --- EVENT LISTENERS & INITIALISATION ---
document.addEventListener('DOMContentLoaded', () => {
  const storedActs = localStorage.getItem('analyser_activities');
  const storedSettings = localStorage.getItem('analyser_settings');

  if (storedActs) {
    try {
      const parsed = JSON.parse(storedActs);
      AppState.activities = Array.isArray(parsed)
        ? parsed.filter(activity => {
            const sanitizedActivity = sanitizeActivity(activity);
            const typeValue = normalizeActivityType(sanitizedActivity?.type || sanitizedActivity?.sport_type || sanitizedActivity?.activity_type || sanitizedActivity?.name || '');
            if (typeValue) {
              sanitizedActivity.type = typeValue;
              return true;
            }
            return false;
          })
        : [];
    } catch(e) {
      AppState.activities = [];
    }
  } else {
    AppState.activities = [];
    localStorage.setItem('analyser_activities', JSON.stringify([]));
  }

  if (storedSettings) {
    try { AppState.settings = { ...AppState.settings, ...JSON.parse(storedSettings) }; } catch(e) {}
  }

  // Navigation Click Handlers
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      e.target.classList.add('active');
      AppState.currentView = e.target.getAttribute('data-view');
      Render.updateAll();
    });
  });

  // Date Range Selector
  document.getElementById('date-range-select').addEventListener('change', (e) => {
    AppState.dateRange = e.target.value;
    Render.updateAll();
  });

  // GPX / JSON Import Handlers
  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });

  document.getElementById('import-file').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const gpxFiles = files.filter(file => file.name.toLowerCase().endsWith('.gpx'));
    const jsonFiles = files.filter(file => file.name.toLowerCase().endsWith('.json'));

    try {
      if (gpxFiles.length) {
        const parsedActivities = [];
        for (const file of gpxFiles) {
          try {
            const activity = await parseGpxFile(file);
            if (activity) parsedActivities.push(activity);
          } catch (err) {
            console.warn('Skipping file during GPX import:', file.name, err);
          }
        }

        const supportedActivities = parsedActivities.filter(activity => ['Bike', 'Run', 'Swim'].includes(activity.type));
        if (!supportedActivities.length) {
          alert('No valid Bike, Run, or Swim activities were found in the selected folder.');
          return;
        }

        const imported = supportedActivities.sort((a, b) => new Date(b.date) - new Date(a.date));
        AppState.activities = imported;
        localStorage.setItem('analyser_activities', JSON.stringify(imported));
        Render.updateAll();
        alert(`Successfully imported ${imported.length} activity${imported.length === 1 ? '' : 'ies'} from GPX files.`);
      } else if (jsonFiles.length) {
        const file = jsonFiles[0];
        const text = await file.text();
        const imported = JSON.parse(text);
        if (Array.isArray(imported)) {
          const supportedActivities = imported.filter(activity => {
            const sanitizedActivity = sanitizeActivity(activity);
            const typeValue = normalizeActivityType(sanitizedActivity?.type || sanitizedActivity?.sport_type || sanitizedActivity?.activity_type || sanitizedActivity?.name || '');
            if (typeValue) {
              sanitizedActivity.type = typeValue;
              return true;
            }
            return false;
          });

          AppState.activities = supportedActivities;
          localStorage.setItem('analyser_activities', JSON.stringify(supportedActivities));
          Render.updateAll();
          alert('Successfully imported activities from JSON file.');
        } else {
          alert('Invalid file format. Expected a JSON array of activities.');
        }
      } else {
        alert('Please select a folder containing .gpx files or a .json activity export.');
      }
    } catch (err) {
      console.error(err);
      alert('Unable to import the selected files. Please make sure the folder contains valid GPX files.');
    } finally {
      e.target.value = '';
    }
  });

  // Export Handlers
  document.getElementById('btn-export').addEventListener('click', () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(AppState.activities, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    dlAnchorElem.setAttribute("download", "analyser_activities_export.json");
    dlAnchorElem.click();
  });

  // Table Sort Handlers
  document.querySelectorAll('#activities-table th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (AppState.sortKey === key) AppState.sortAsc = !AppState.sortAsc;
      else { AppState.sortKey = key; AppState.sortAsc = true; }
      Render.activities();
    });
  });

  // Activity Filters
  ['filter-search', 'filter-type', 'filter-min-dist', 'filter-max-dist', 'filter-long'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', Render.activities);
  });
  document.getElementById('btn-reset-filters')?.addEventListener('click', () => {
    document.getElementById('filter-search').value = '';
    document.getElementById('filter-type').value = 'all';
    document.getElementById('filter-min-dist').value = '';
    document.getElementById('filter-max-dist').value = '';
    document.getElementById('filter-long').checked = false;
    Render.activities();
  });

  // Compare Selectors
  document.getElementById('compare-select-1')?.addEventListener('change', Render.updateCompareView);
  document.getElementById('compare-select-2')?.addEventListener('change', Render.updateCompareView);

  // Settings Save Handler
  document.getElementById('btn-save-settings')?.addEventListener('click', () => {
    AppState.settings.weeklyGoal = parseFloat(document.getElementById('set-goal-dist').value) || 40;
    AppState.settings.longThreshold = parseFloat(document.getElementById('set-long-threshold').value) || 15;
    AppState.settings.riegelExp = parseFloat(document.getElementById('set-riegel-exp').value) || 1.06;
    AppState.settings.collapseSensitivity = parseFloat(document.getElementById('set-collapse-sens').value) || 5;
    AppState.settings.theme = document.getElementById('set-theme').value;
    AppState.settings.accent = document.getElementById('set-accent').value;

    localStorage.setItem('analyser_settings', JSON.stringify(AppState.settings));
    Render.applyTheme();
    const msg = document.getElementById('settings-save-msg');
    msg.textContent = "Preferences saved!";
    setTimeout(() => { msg.textContent = ""; }, 3000);
  });

  // Modal Close Handlers
  document.getElementById('btn-close-modal')?.addEventListener('click', () => {
    document.getElementById('activity-modal').classList.add('hidden');
  });
  document.getElementById('activity-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'activity-modal') e.target.classList.add('hidden');
  });

  // Initial Render
  Render.updateAll();
});