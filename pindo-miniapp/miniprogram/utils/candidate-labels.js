const CANDIDATE_LABELS = {
  detail: '保主体细节',
  color: '保色彩层次',
  few: '保少色号',
};

/** 候选的中文名称统一在此维护，避免首页与图纸库两处走样。 */
function labelForCandidate(candidateId) {
  return CANDIDATE_LABELS[candidateId] || '已保存图纸';
}

module.exports = { labelForCandidate };
