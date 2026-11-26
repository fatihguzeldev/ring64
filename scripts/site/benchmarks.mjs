const workloads = [
  { id: 'xor-shift', name: 'xorshift', axis: 'compute' },
  { id: 'f32-matvec', name: 'matrix × vector', axis: 'compute' },
  { id: 'binary-search', name: 'binary search', axis: 'data' },
  { id: 'chase-large', name: 'pointer chase', axis: 'data' },
  { id: 'texture-spans-opaque', name: 'opaque texture spans', axis: 'data' },
];
const count = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function median(times) {
  if (!times.length || !times.every((ms) => Number.isFinite(ms) && ms > 0))
    throw new Error('expected positive benchmark times in milliseconds');
  const sorted = times.toSorted((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

function hostPair(runs, bits, peer) {
  const hosts = runs.filter((run) => run.bits === bits && run.peer === peer);
  if (
    hosts.length !== 2 ||
    !['macOS', 'Windows'].every((os) => hosts.some((run) => run.platform === os))
  )
    throw new Error(`expected one macos and one windows result for ${bits}-bit`);
  for (const engine of ['ring64', peer]) {
    if (hosts[0].revisions[engine] !== hosts[1].revisions[engine])
      throw new Error(`inconsistent ${engine} revisions for ${bits}-bit`);
  }
  return hosts;
}

function comparison(results, bits, peer) {
  const fullRun = hostPair(results.runs, bits, peer);
  const workloadHosts = workloads.map(({ id }) => {
    const updates = results.workloadUpdates?.[id]?.filter((run) => run.bits === bits);
    return updates?.length ? hostPair(updates, bits, peer) : fullRun;
  });
  const points = ['ring64', peer].map((engine) => {
    const times = workloads.map(({ id }, i) => {
      const hosts = workloadHosts[i];
      return hosts.reduce((sum, host) => sum + median(host.timings[id][engine]), 0) / hosts.length;
    });
    const totals = { compute: 0, data: 0 };
    workloads.forEach(({ axis }, i) => {
      totals[axis] += times[i];
    });
    return { engine, times, x: 1000 / totals.compute, y: 1000 / totals.data };
  });
  return { bits, points };
}

function ticks(limit, axis) {
  const dimension = axis === 'x' ? 'left' : 'bottom';
  const positions = axis === 'x' ? [0, 50, 100] : [50, 100];
  return positions
    .map(
      (percent) =>
        `<span class="bench-tick bench-${axis}tick" style="${dimension}:${percent}%">${count.format((limit * percent) / 100)}</span>`,
    )
    .join('');
}

function figure({ bits, points }, xMax, yMax) {
  const description = points
    .map(
      ({ engine, x, y }) =>
        `${engine}: ${count.format(x)} compute rounds and ${count.format(y)} data rounds per second.`,
    )
    .join(' ');
  const labels = points
    .map(({ engine, x, y }) => {
      const left = (100 * x) / xMax;
      const bottom = (100 * y) / yMax;
      const below = bottom > 80 || (engine !== 'ring64' && bottom > 20);
      const placement = (left > 70 ? ' label-left' : '') + (below ? ' label-below' : '');
      return `<span class="bench-point ${engine}${placement}" style="left:${left}%;bottom:${bottom}%"><span class="bench-point-label">${engine}</span></span>`;
    })
    .join('');
  return `<figure class="bench-machine">
    <figcaption><h2>${bits}-bit</h2></figcaption>
    <div class="bench-y-label" aria-hidden="true">data rounds/s</div>
    <div class="bench-plot" role="img" aria-label="${description}">${ticks(xMax, 'x')}${ticks(yMax, 'y')}${labels}</div>
    <div class="bench-x-label" aria-hidden="true">compute rounds/s</div>
  </figure>`;
}

export function renderBenchmarks(html, results) {
  const comparisons = [comparison(results, 64, 'v64'), comparison(results, 32, 'v86')];
  const points = comparisons.flatMap(({ points }) => points);
  const xMax = 1000 * Math.ceil(Math.max(...points.map(({ x }) => x)) / 1000);
  const yMax = 100 * Math.ceil(Math.max(...points.map(({ y }) => y)) / 100);
  const rows = workloads.map(({ name }, i) => {
    const times = points
      .map(({ times }) => `<td>${times[i].toFixed(3)} <span>ms</span></td>`)
      .join('');
    return `<tr><th scope="row">${name}</th>${times}</tr>`;
  });
  return html
    .replace('<!-- benchmark-figures -->', () =>
      comparisons.map((c) => figure(c, xMax, yMax)).join('\n'),
    )
    .replace('<!-- benchmark-rows -->', () => rows.join('\n'));
}
