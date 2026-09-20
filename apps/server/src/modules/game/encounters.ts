/**
 * 秘境探索遭遇池（V6 第四节）——纯数据 + 纯函数。
 *
 * 与 events.ts / realms.ts / alchemy.ts 的特定玩法定义同理：遭遇场景是少量游戏内容，
 * 硬编码在游戏模块代码里，不进 GameConfigContent，也不进数据库。
 *
 * 本文件只放数据与抽取逻辑：不读数据库、不取时间（不调用 Date.now()）、不打印日志。
 * 随机源 `random` 可注入，默认 Math.random，便于测试复现。
 */

/**
 * 难度上限常量（代替 Infinity）。
 * EncounterDef.maxDifficulty 用 99999 表示「无上限」：Infinity 无法进 JSON / 数据库。
 */
export const MAX_DIFFICULTY = 99999;

export interface EncounterChoice {
  id: string;
  label: string;
  riskHint: string;
}

export interface EncounterDef {
  id: string;
  category: 'beast' | 'treasure' | 'trap' | 'fortune' | 'hazard' | 'npc';
  name: string;
  description: string;
  minDifficulty: number;
  /** 难度上限；Infinity 用 99999 表示（见 MAX_DIFFICULTY）。 */
  maxDifficulty: number;
  choices: EncounterChoice[];
}

export const ENCOUNTERS: readonly EncounterDef[] = [
  /* ---------- 妖兽遭遇 ---------- */
  {
    id: 'beast_wolf',
    category: 'beast',
    name: '雾中妖狼',
    description:
      '浓雾深处传来低沉的喉音，一头灰白妖狼缓缓踱出，绿瞳死死锁住你的队伍。它的后腿绷紧，随时可能扑上来。',
    minDifficulty: 0,
    maxDifficulty: 1500,
    choices: [
      { id: 'fight', label: '正面迎战', riskHint: '风险较高，可能受伤' },
      { id: 'ambush', label: '布阵围杀', riskHint: '需要配合，但较为稳妥' },
      { id: 'sneak', label: '潜行绕过', riskHint: '安全但无额外收获' },
    ],
  },
  {
    id: 'beast_python',
    category: 'beast',
    name: '巨蟒拦路',
    description:
      '前方的石道上盘着一条青鳞巨蟒，蛇身粗如水缸，几乎堵死整条通路。它缓缓抬起头颅，吐出的信子带着腥风。',
    minDifficulty: 0,
    maxDifficulty: 1500,
    choices: [
      { id: 'force', label: '以力破之', riskHint: '风险偏高，或可斩获蛇材' },
      { id: 'lure', label: '引蛇出洞', riskHint: '需要耐心，成功收获颇丰' },
      { id: 'detour', label: '绕道而行', riskHint: '稳妥省力，但一无所获' },
    ],
  },
  {
    id: 'beast_scorpion',
    category: 'beast',
    name: '毒蝎群',
    description:
      '沙砾间忽地钻出数十只黑甲毒蝎，尾针高高翘起，围成半圈。它们的鳞甲泛着油光，显然久食灵气。若贸然靠近，只怕会被群起而攻。',
    minDifficulty: 100,
    maxDifficulty: 1500,
    choices: [
      { id: 'fire', label: '以火驱散', riskHint: '消耗灵力，但能全身而退' },
      { id: 'dash', label: '快速通过', riskHint: '冒险抢行，可能被蛰伤' },
      { id: 'nest', label: '寻找巢穴', riskHint: '风险较高，或能寻得蝎宝' },
    ],
  },
  {
    id: 'beast_cub',
    category: 'beast',
    name: '幼年灵兽',
    description:
      '一只毛色雪白的小兽缩在岩缝里，圆眼惊惶地望着你，周身还有微弱的灵气流转。它显然刚与母兽失散，毫无敌意。',
    minDifficulty: 0,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'tame', label: '收服灵兽', riskHint: '需要安抚，成功可添助力' },
      { id: 'leave', label: '悄然离开', riskHint: '安全无虞，却错失机缘' },
    ],
  },
  {
    id: 'beast_bats',
    category: 'beast',
    name: '魔蝠群',
    description:
      '头顶的窟窿里涌出一片黑云，成百只魔蝠尖啸着盘旋而下。它们的獠牙泛着寒光，专往灵气浓郁处扑。',
    minDifficulty: 0,
    maxDifficulty: 1500,
    choices: [
      { id: 'repel', label: '以灵气震散', riskHint: '消耗灵力，可保众人无伤' },
      { id: 'burn', label: '放火清场', riskHint: '风险中等，或引来强敌' },
      { id: 'crouch', label: '伏低潜行', riskHint: '安静稳妥，但路窄难行' },
    ],
  },
  {
    id: 'beast_bear',
    category: 'beast',
    name: '石甲巨熊',
    description:
      '一头石甲巨熊挡在谷口，皮毛硬如岩石，每一次呼吸都震得地面微颤。它低哮着拍碎身旁的石壁，显然已把此处视作领地。',
    minDifficulty: 300,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'fight', label: '全力一战', riskHint: '凶险异常，胜则收获丰厚' },
      { id: 'lure', label: '以灵果诱走', riskHint: '需备灵果，或可化险为夷' },
      { id: 'retreat', label: '退避三舍', riskHint: '安全撤走，但白跑一程' },
    ],
  },

  /* ---------- 宝物发现 ---------- */
  {
    id: 'treasure_herb',
    category: 'treasure',
    name: '荧光灵草',
    description:
      '一处阴湿的岩壁下，几株灵草正泛着幽幽荧光，叶片上凝着灵露。此地灵气稀薄，却独独养出这一小丛药性。',
    minDifficulty: 0,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'careful', label: '仔细采集', riskHint: '稳妥取苗，收获虽少却稳' },
      { id: 'root', label: '连根拔起', riskHint: '收获更丰，但可能损了药性' },
    ],
  },
  {
    id: 'treasure_pouch',
    category: 'treasure',
    name: '废弃储物袋',
    description:
      '乱石堆里躺着一只破旧的储物袋，袋口尚缠着半截禁制符。看样式，它的主人多半已久不在此。禁制虽残，却未必全然失效。',
    minDifficulty: 0,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'probe', label: '谨慎探查', riskHint: '稳妥排查，或能避开陷阱' },
      { id: 'open', label: '直接打开', riskHint: '可能中伏，也可能得宝' },
      { id: 'leave', label: '留给后人', riskHint: '安全无害，却空手而过' },
    ],
  },
  {
    id: 'treasure_jade',
    category: 'treasure',
    name: '裂纹玉简',
    description:
      '石台上摆着一枚布满裂纹的玉简，幽光在其中若隐若现。它似乎记着某种功法，只是残缺得厉害。若强行解读，恐怕反遭其反噬。',
    minDifficulty: 0,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'study', label: '尝试参悟', riskHint: '耗费心神，或能悟出残篇' },
      { id: 'keep', label: '小心收起', riskHint: '稳妥收纳，日后再行研究' },
    ],
  },
  {
    id: 'treasure_vein',
    category: 'treasure',
    name: '矿脉露头',
    description:
      '断崖上露出一截晶亮的矿脉，灵石的光泽在裂隙间流转。此处矿质虽不算顶级，却胜在储量可观。只是崖壁陡峭，开采并不轻松。',
    minDifficulty: 0,
    maxDifficulty: 1500,
    choices: [
      { id: 'mine', label: '就地开采', riskHint: '耗时耗力，但收获实在' },
      { id: 'mark', label: '标记位置', riskHint: '省下力气，留给宗门开采' },
    ],
  },
  {
    id: 'treasure_corpse',
    category: 'treasure',
    name: '古修遗骸',
    description:
      '一具盘坐的枯骨倚在石壁旁，衣袍早已风化成灰。他的指骨间还夹着半枚残破玉牌，似有未尽之意。',
    minDifficulty: 300,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'loot', label: '搜寻遗物', riskHint: '或有重宝，也可能触发禁制' },
      { id: 'salute', label: '行礼离去', riskHint: '不解怨气，稳妥却无所得' },
    ],
  },

  /* ---------- 陷阱机关 ---------- */
  {
    id: 'trap_array',
    category: 'trap',
    name: '困仙阵残余',
    description:
      '碎石间的青纹忽明忽暗，隐约勾勒出一座残缺的大阵。只要再踏近半步，扑面而来的灵压便足以让人警觉。',
    minDifficulty: 300,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'break', label: '破阵而入', riskHint: '凶险极大，破开则直通深处' },
      { id: 'eye', label: '寻找阵眼', riskHint: '需要眼力，稳妥破阵更省力' },
      { id: 'detour', label: '绕道而行', riskHint: '安全避开，但多耗脚程' },
    ],
  },
  {
    id: 'trap_cave',
    category: 'trap',
    name: '塌方暗道',
    description:
      '原本的通道被塌落的碎石堵去大半，只余一道窄缝透出微光。头顶还不时有碎石簌簌落下。若贸然钻入，谁也不知会不会再度塌下。',
    minDifficulty: 0,
    maxDifficulty: 1500,
    choices: [
      { id: 'force', label: '强行通过', riskHint: '冒险钻行，或会被困其中' },
      { id: 'support', label: '以术支撑', riskHint: '消耗灵力，却可稳住通道' },
      { id: 'seek', label: '另寻出路', riskHint: '安全绕行，但耽误行程' },
    ],
  },
  {
    id: 'trap_fog',
    category: 'trap',
    name: '毒雾谷地',
    description:
      '谷底漫着一层暗紫色的浓雾，雾中草木尽数枯死。风一停，那雾气便悄无声息地朝着行人涌来。你隐约闻到一股甜腻的腐味。',
    minDifficulty: 0,
    maxDifficulty: 1500,
    choices: [
      { id: 'rush', label: '以灵气护体冲过', riskHint: '耗损灵力，可强行闯过' },
      { id: 'windward', label: '寻找上风口', riskHint: '需要绕行，但较为稳妥' },
      { id: 'wait', label: '等雾散去', riskHint: '安全等待，却空耗时辰' },
    ],
  },
  {
    id: 'trap_illusion',
    category: 'trap',
    name: '幻境迷阵',
    description:
      '眼前景物忽然如水纹般荡开，你看见来路与去路都化作同一片密林。四周的鸟鸣声整齐得不似天成。',
    minDifficulty: 100,
    maxDifficulty: 1500,
    choices: [
      { id: 'heart', label: '以心魔入阵', riskHint: '凶险莫测，或能一举破幻' },
      { id: 'blind', label: '闭目前行', riskHint: '听声辨位，较为稳妥' },
      { id: 'back', label: '原路退回', riskHint: '安全退出，但前功尽弃' },
    ],
  },
  {
    id: 'trap_rock',
    category: 'trap',
    name: '落石机关',
    description:
      '通道两侧的石壁布满小孔，地面中央有一块微微下陷的石板。你脚尖刚触到边缘，头顶便传来滚动的闷响。',
    minDifficulty: 0,
    maxDifficulty: 1500,
    choices: [
      { id: 'dash', label: '极速冲刺', riskHint: '抢时机，但极易被砸中' },
      { id: 'block', label: '以术挡石', riskHint: '耗费灵力，却稳妥可行' },
      { id: 'observe', label: '等待观察', riskHint: '耐心试探，安全但耗时' },
    ],
  },

  /* ---------- 奇遇机缘 ---------- */
  {
    id: 'fortune_spring',
    category: 'fortune',
    name: '灵泉涌出',
    description:
      '岩缝中忽然涌出一股清冽泉水，水汽氤氲，灵气比周围浓郁数倍。泉眼不大，却足以让人就地打坐一番。',
    minDifficulty: 0,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'drink', label: '饮泉修炼', riskHint: '就地吐纳，收益最为直接' },
      { id: 'collect', label: '收集泉水', riskHint: '稳妥存下，日后仍可受用' },
    ],
  },
  {
    id: 'fortune_material',
    category: 'fortune',
    name: '天材地宝',
    description:
      '一株通体赤红的老药扎根在崖顶，叶脉间灵气流转如血脉。看其年份，少说也有数百年火候。只是它扎根极深，稍有不慎便会伤及药根。',
    minDifficulty: 0,
    maxDifficulty: 1500,
    choices: [
      { id: 'full', label: '全力采取', riskHint: '尽数取走，却可能伤了灵根' },
      { id: 'partial', label: '只取少许', riskHint: '留有余地，收获亦算稳妥' },
    ],
  },
  {
    id: 'fortune_scroll',
    category: 'fortune',
    name: '残缺功法',
    description:
      '半卷残破的功法摊在一块平整石上，字迹被水浸得模糊。可你仍能辨出几句吐纳口诀，颇为精妙。只是字迹残缺，读来颇费心神。',
    minDifficulty: 0,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'now', label: '当场参悟', riskHint: '就地试炼，或有意外收获' },
      { id: 'carry', label: '带回研究', riskHint: '稳妥保存，回宗门再细究' },
    ],
  },
  {
    id: 'fortune_stele',
    category: 'fortune',
    name: '神秘石碑',
    description:
      '一块无字石碑矗立在空地上，表面覆着深沉的暗纹。你才靠近数步，便觉神识微微一颤。碑面空无一字，却似藏着千钧道意。',
    minDifficulty: 0,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'touch', label: '触碰石碑', riskHint: '风险不明，或得莫大机缘' },
      { id: 'copy', label: '抄录碑文', riskHint: '稳妥记录，收益或许有限' },
      { id: 'stay', label: '保持距离', riskHint: '不涉险境，但一无所获' },
    ],
  },
  {
    id: 'fortune_nexus',
    category: 'fortune',
    name: '灵脉交汇',
    description:
      '脚下正处两条灵脉交汇之处，地气翻涌，连石缝都在渗出灵光。若在此久留，只怕引动地脉反噬。灵光顺着石缝汇聚，隐隐映出两条交错的脉络。',
    minDifficulty: 300,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'absorb', label: '就地吸收', riskHint: '收益极快，可能反噬伤身' },
      { id: 'guide', label: '布阵引导', riskHint: '布阵费时，却更为稳妥' },
    ],
  },

  /* ---------- 环境险境 ---------- */
  {
    id: 'hazard_surge',
    category: 'hazard',
    name: '灵气暴动',
    description:
      '四周灵气骤然躁动，卷起肉眼可见的气旋，折断了近处的枯枝。这股暴动毫无预兆，且越往深处越烈。',
    minDifficulty: 300,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'absorb', label: '顺势吸收', riskHint: '险中求利，可能撑爆经脉' },
      { id: 'resist', label: '全力抵御', riskHint: '消耗灵力，可稳住身形' },
      { id: 'hide', label: '找掩体躲避', riskHint: '安全避让，却错失良机' },
    ],
  },
  {
    id: 'hazard_rift',
    category: 'hazard',
    name: '地裂深渊',
    description:
      '地面豁开一道深不见底的裂缝，边缘碎石不断坠落，久久不闻回声。裂口宽约数丈，恰在必经之路上。',
    minDifficulty: 300,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'leap', label: '飞跃而过', riskHint: '一鼓作气，失足则万劫不复' },
      { id: 'edge', label: '沿边寻路', riskHint: '绕行较远，但相对安全' },
      { id: 'bridge', label: '用法器架桥', riskHint: '耗损法器，换取稳妥通行' },
    ],
  },
  {
    id: 'hazard_ice',
    category: 'hazard',
    name: '寒冰禁区',
    description:
      '前方已是终年不化的冰原，寒风如刀，连呼出的气都结成细霜。冰面下暗流涌动，隐约透出深蓝光泽。',
    minDifficulty: 100,
    maxDifficulty: 1500,
    choices: [
      { id: 'fire', label: '以火属灵力开路', riskHint: '耗损灵力，可稳步破冰前行' },
      { id: 'slow', label: '缓慢穿越', riskHint: '谨慎挪行，胜在稳妥省力' },
      { id: 'detour', label: '绕远路', riskHint: '安全无忧，但耽误不少脚程' },
    ],
  },
  {
    id: 'hazard_lava',
    category: 'hazard',
    name: '熔岩暗河',
    description:
      '一条熔岩暗河横在前方，赤红浆流缓慢翻涌，热浪烤得人面皮发紧。河面之上仅有几处浮石可供落足。',
    minDifficulty: 300,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'cool', label: '以水术降温', riskHint: '耗损灵力，硬铺一条通路' },
      { id: 'bridge', label: '找石桥通过', riskHint: '需多加试探，稳妥但耗时' },
      { id: 'back', label: '回头另找', riskHint: '安全放弃，另寻他路' },
    ],
  },
  {
    id: 'hazard_void',
    category: 'hazard',
    name: '空间裂缝',
    description:
      '半空中悬着一道漆黑裂缝，边缘光线都被扭曲吞没。偶尔有碎石飘近，眨眼间便消失得无影无踪。裂缝边缘微微颤动，仿佛随时都会扩大。',
    minDifficulty: 300,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'cross', label: '冒险穿越', riskHint: '九死一生，或直达秘境深处' },
      { id: 'probe', label: '抛物试探', riskHint: '先探深浅，稳妥却费时' },
      { id: 'wait', label: '等裂缝闭合', riskHint: '安全等待，但可能错过时机' },
    ],
  },

  /* ---------- 神秘人物 ---------- */
  {
    id: 'npc_merchant',
    category: 'npc',
    name: '游商散修',
    description:
      '一名背着货箱的散修从雾中走出，笑呵呵地朝你拱手。他自称常年行走秘境，愿意与人以物易物。他的货箱半开，隐约露出几瓶丹药与几卷残简。',
    minDifficulty: 0,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'trade', label: '与之交易', riskHint: '各取所需，价格或有高低' },
      { id: 'pass', label: '擦肩而过', riskHint: '毫无风险，却也无所得' },
    ],
  },
  {
    id: 'npc_wounded',
    category: 'npc',
    name: '受伤修士',
    description:
      '一名修士瘫坐在乱石间，胸口血迹未干，见你到来便露出戒备又期盼的神色。他怀里紧抱着一只残缺的玉瓶。',
    minDifficulty: 0,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'help', label: '出手相助', riskHint: '耗费丹药，或换得知恩图报' },
      { id: 'ignore', label: '视而不见', riskHint: '安全离去，却难免负疚' },
    ],
  },
  {
    id: 'npc_puppet',
    category: 'npc',
    name: '守关傀儡',
    description:
      '石门两侧各立一尊石傀儡，眼窝里燃着幽蓝火光。你的脚步刚踏上石阶，它们便齐齐转头望来。石屑簌簌落下，它们已缓缓抬起沉重的石臂。',
    minDifficulty: 300,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'fight', label: '正面挑战', riskHint: '硬碰硬，胜则收获丰厚' },
      { id: 'search', label: '寻找机关', riskHint: '需多费心思，破关更为稳妥' },
      { id: 'bypass', label: '尝试绕过', riskHint: '险中求巧，或触发守卫' },
    ],
  },
  {
    id: 'npc_disguised',
    category: 'npc',
    name: '疑似妖修',
    description:
      '一名白衣修士倚在树下抚琴，气息纯净得有些刻意。你注意到他袖口沾着一缕不易察觉的青色鳞屑。',
    minDifficulty: 0,
    maxDifficulty: 1500,
    choices: [
      { id: 'strike', label: '先下手为强', riskHint: '抢占先机，却可能冤枉好人' },
      { id: 'talk', label: '试探交流', riskHint: '以话探底，胜负尚在两可' },
      { id: 'alert', label: '保持警惕', riskHint: '静观其变，稳妥但无所获' },
    ],
  },
  {
    id: 'npc_senior',
    category: 'npc',
    name: '前辈高人',
    description:
      '一名白发老者盘坐在崖边，周身气息内敛如常。他抬眼看你一眼，仿佛已将你的深浅看得通透。他并不言语，只是安静地看着远处的云海。',
    minDifficulty: 0,
    maxDifficulty: MAX_DIFFICULTY,
    choices: [
      { id: 'salute', label: '恭敬行礼', riskHint: '以礼相待，或得指点一二' },
      { id: 'ask', label: '请教道法', riskHint: '贸然求教，或有冒犯之嫌' },
      { id: 'leave', label: '默默离开', riskHint: '不生事端，也无所获' },
    ],
  },
];

/**
 * 不改写原数组的 Fisher-Yates 洗牌 + 取前 count 个。
 * 与 challenge.ts 的 shufflePick 同一写法，但本模块保持独立，不跨文件 import。
 */
function shuffleTake<T>(items: readonly T[], count: number, random: () => number): T[] {
  const pool = [...items];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const temp = pool[index];
    pool[index] = pool[swapIndex];
    pool[swapIndex] = temp;
  }
  return pool.slice(0, Math.max(0, count));
}

/**
 * 从符合难度范围（minDifficulty <= difficulty <= maxDifficulty）且不在 excludeIds 里的
 * 场景中随机抽 count 个，返回的数组内不会有重复 id。
 *
 * 兜底链（保证调用方尽量拿到结果，不因池子空而卡住玩家）：
 * 1. 正常候选：难度匹配 + 尊重 excludeIds；
 * 2. 只放宽 exclude：难度匹配但忽略 excludeIds，补齐差额；
 * 3. 只放宽难度：ENCOUNTERS 全体，仍尊重 excludeIds；
 * 4. 最后忽略 exclude：ENCOUNTERS 全体。
 *
 * `random` 可注入（默认 Math.random）以便测试；抽取过程不改写入参。count <= 0 返回 []。
 * 异常难度（NaN / Infinity / 负数）不会抛错：NaN 会走「只放宽难度」这条兜底路径。
 */
export function drawEncounters(
  difficulty: number,
  count: number,
  excludeIds: readonly string[],
  random: () => number = Math.random,
): EncounterDef[] {
  if (count <= 0) {
    return [];
  }

  const excluded = new Set(excludeIds);
  const picked: EncounterDef[] = [];
  const pickedIds = new Set<string>();

  const fill = (pool: readonly EncounterDef[], honorExclude: boolean): void => {
    if (picked.length >= count) {
      return;
    }
    const candidates = pool.filter(
      (encounter) =>
        !pickedIds.has(encounter.id) && !(honorExclude && excluded.has(encounter.id)),
    );
    for (const encounter of shuffleTake(candidates, count - picked.length, random)) {
      picked.push(encounter);
      pickedIds.add(encounter.id);
    }
  };

  const difficultyPool = ENCOUNTERS.filter(
    (encounter) => encounter.minDifficulty <= difficulty && difficulty <= encounter.maxDifficulty,
  );

  fill(difficultyPool, true); // 1) 难度匹配 + 尊重 exclude
  fill(difficultyPool, false); // 2) 只放宽 exclude
  fill(ENCOUNTERS, true); // 3) 只放宽难度
  fill(ENCOUNTERS, false); // 4) 忽略 exclude

  return picked;
}
