'use strict';
// Neutral MergeRepo fixtures: pass the repo path for each project a test needs.
const DEFS = {
  beta: { project: 'BetaGame', aliases: ['Beta', 'Alpha'], mentions: ['Beta', 'Alpha', 'alpha-'], branch: 'master' },
  gamma: { project: 'GammaGame', aliases: ['Gamma'], mentions: ['Gamma', 'gamma-'], branch: 'main' },
  camp: { project: 'Camp', aliases: ['munder-difflin'], mentions: ['Camp'], branch: 'integration' }
};

function mergeRepos(paths) {
  return Object.keys(DEFS)
    .filter((k) => paths[k])
    .map((k) => ({ ...DEFS[k], path: paths[k] }));
}

module.exports = { mergeRepos, DEFS };
