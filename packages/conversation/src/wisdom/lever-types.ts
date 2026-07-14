/**
 * 智慧干预（wise interventions，Walton/Wilson 一系）的类型定义。
 *
 * 核心主张：让人卡住的往往不是事件本身，而是对事件的解释方式（construal）。
 * 因此系统不去"解决问题"，也不安慰式地否定情绪，而是在**反复出现**的消极解释上，
 * 用一个小问题把解释权交回用户，让用户自己说出另一种解释（saying-is-believing）。
 *
 * 三条纪律（决定了下面所有类型的形状）：
 *   1. 只记录、不诊断：命中一次杠杆只是"这句话里有这种解释方式"，必须带原话片段可回溯。
 *   2. 反复才干预：单次低落是正常情绪，不是认知模式；干预闸门看滚动窗口内的复现。
 *   3. 用户自己说出来的才算数：AI 说的积极解释一律不写进画像，只有用户自述的 preferred_narrative 才写。
 */

/** 消极解释的四种杠杆（可被一个小问题撬动的地方）。 */
export type ConstrualLever =
  | "belonging_uncertainty" // "只有我格格不入"——把一次挫折读成"我不属于这里"
  | "fixed_attribution" // "我就是不行"——把一次失败读成固定的、全局的自我特质
  | "hostile_attribution" // "他就是针对我"——把模糊的行为默认读成敌意
  | "self_continuity_threat"; // "我再也回不去了"——把当下断裂读成自我的永久性丧失

export const ALL_LEVERS: ConstrualLever[] = [
  "belonging_uncertainty",
  "fixed_attribution",
  "hostile_attribution",
  "self_continuity_threat",
];

export const LEVER_LABELS: Record<ConstrualLever, string> = {
  belonging_uncertainty: "归属感焦虑（觉得只有自己格格不入/不被接纳）",
  fixed_attribution: "固定性自我归因（把一次挫折说成自己天生就不行、哪哪都不行）",
  hostile_attribution: "敌意归因（把别人模糊的言行默认解读为针对、故意）",
  self_continuity_threat: "自我连续性断裂（觉得自己回不到从前、再也不是原来的自己）",
};

/** 一次杠杆命中。quote 必须是用户原话里的片段，便于回溯与防幻觉。 */
export interface LeverHit {
  lever: ConstrualLever;
  confidence: number; // 0..1
  quote: string;
}

export interface LeverDetection {
  hits: LeverHit[];
  /** 是否走了 LLM 检测（false = 被廉价前置门挡掉，没有花钱）。 */
  detected: boolean;
}

/** 一条支撑首选叙事的微证据（来自后续几天的真实事件，不是模型编的）。 */
export interface NarrativeEvidence {
  date: string; // YYYY-MM-DD
  detail: string;
  eventId?: string;
}

/**
 * 首选叙事：用户在被反问后**自己说出**的那句更宽的解释。
 * 它不是"正能量金句"，而是这个人自己的话——之后由证据链去印证它。
 */
export interface PreferredNarrative {
  lever: ConstrualLever;
  statement: string; // 用户自述（尽量保留用户自己的措辞）
  capturedAt: string; // YYYY-MM-DD
  evidence: NarrativeEvidence[];
}

export type WisdomSkipReason =
  | "disabled"
  | "no_owner"
  | "sensitive" // 危机/丧失类内容：绝不做业余心理干预，只做在场与陪伴
  | "no_distress" // 廉价前置门：这句里没有低落/挫折信号
  | "no_lever" // 有低落但没识别出消极解释方式
  | "not_recurring" // 只出现过一次：正常情绪波动，不是认知模式
  | "cooldown"; // 最近刚干预过：避免变成"每次难过都被反问"的骚扰

/** 在线闸门的产物：要不要干预、用什么撬、注入回复的提示块。 */
export interface WisdomPlan {
  intervene: boolean;
  lever?: ConstrualLever;
  /** 未干预时的原因；干预时为 undefined。 */
  skipReason?: WisdomSkipReason;
  /** 反问所锚定的历史反例（用户自己的成功/顺利经历），可能为空。 */
  counterEvidence: NarrativeEvidence[];
  /** 注入回复 prompt 的文本块；不干预时为空串。 */
  text: string;
  /** 本次识别到的杠杆命中（无论是否干预，都会落库用于统计复现）。 */
  hits: LeverHit[];
}

export const EMPTY_PLAN: WisdomPlan = { intervene: false, counterEvidence: [], text: "", hits: [] };
