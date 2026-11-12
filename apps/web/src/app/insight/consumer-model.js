const cards = [
  {
    title: '时空上下文的消费场景一：查询',
    question: '「我妈上次住院的时候，我在哪？」',
    steps: [
      {
        index: '①',
        title: '拆解',
        rows: [
          ['实体', '「妈」→ 两个候选：王秀兰、张桂芳（都是我的「妈」）'],
          ['关系', '要查的是：谁在住院，谁在陪护'],
          ['时间', '2025.01'],
        ],
      },
      {
        index: '②',
        title: '检索',
        rows: [
          ['别名', '精确命中优先：「妈」直接对上 p_0187、p_0264 的 meta.aliases'],
          ['向量', '对实体摘要和关系描述做语义检索，把别名对不上的说法也召回，返回 top-k 而不是只取第一名'],
        ],
      },
      {
        index: '③',
        title: '查关系',
        rows: [
          ['按实体', '取 relations 里涉及这两个实体的行：6 条'],
          ['按时间', '筛 valid_from / valid_to 覆盖 2025.01 的：剩 1 条（rec_04）'],
        ],
      },
      {
        index: '④',
        title: '回到记录',
        rows: [
          ['取原文', '用 relations.record 回原始记录：rec_04 · 港大医院挂号单 · 2025.01.22 08:40'],
          ['依据', '答案只引原文，不引中间推导'],
        ],
      },
      {
        index: '⑤',
        title: '判断',
        rows: [
          ['交给模型', '问题、候选实体、关系、原文一起交给大模型'],
          ['答案', '张桂芳在港大医院就诊，那天我在陪护她'],
        ],
      },
    ],
  },
  {
    title: '时空上下文的消费场景二：洞察',
    question: '「最近两周，我的安排有没有冲突？」',
    steps: [
      {
        index: '①',
        title: '圈范围',
        rows: [
          ['实体', '我'],
          ['时间窗', '2025.01.01 – 2025.01.28'],
        ],
      },
      {
        index: '②',
        title: '取关系',
        rows: [
          ['按区间取', '取 valid_from / valid_to 与这个窗口相交的行：4 条（2 条从更早延续至今，2 条落在窗口里）'],
          ['带原文', '每条都保留 record 指针，后面要靠它取证'],
        ],
      },
      {
        index: '③',
        title: '找重叠',
        rows: [
          ['区间相交', '就诊 2025.01.22 → 未知；出行 2025.01.28 单日 → 同一天两条都成立'],
          ['互斥判断', '人在港大医院陪护，又回老家，同一时刻只能在一处'],
        ],
      },
      {
        index: '④',
        title: '回证据',
        rows: [
          ['rec_04', '挂号单：张桂芳 · 陪护 我 · 港大医院'],
          ['rec_05', '行程：「回老家」1 月 28 日 高铁票 · 未支付'],
        ],
      },
      {
        index: '⑤',
        title: '给结论',
        rows: [
          ['洞察', '不是数据脏了，是两个事实撞在一起，等你裁决：28 号回老家，还是在医院陪护'],
          ['置信度', '两条都有原文，不猜；没有证据的关联不报'],
        ],
      },
    ],
  },
  {
    variant: 'gates',
    title: '时空上下文的消费场景三：去噪',
    cases: [
      {
        glyph: 'call',
        kind: '陌生来电 · 09:41',
        from: '138****2210　自称「XX 培训机构」',
        did: '先接，问清来意，回一句「暂时不需要校外辅导」，挂断',
        verdict: '没响铃',
      },
      {
        glyph: 'contact',
        kind: '加联系人 · 18:20',
        from: '「您好，我是安家房产的王经理」',
        did: '先问清楚是推房源、想挂牌，回「暂时不买不卖，也不看房」，请求不通过',
        verdict: '没打扰',
      },
      {
        glyph: 'chat',
        kind: '亲戚提问 · 20:05',
        from: '「我妈上次住院挂的哪个科？」',
        did: '库里已有答案，直接回「港大医院，1 月 22 日挂的号，当时我在陪护」',
        verdict: '直接答',
      },
    ],
    rules: [
      ['常识', '培训机构、房产中介、亲戚问一句病情，这些事本身的性质，大模型自己判得出来，不用你教'],
      ['你的数据', '再压上你自己的一层：关系里没有报班、没有看房、没有挂牌，这件事跟你没有连接，就不该占你的时间'],
      ['此刻', '港大医院陪护 2025.01.22 → 未知 还在进行，亲戚问的那句不用等你回，它现在就答得出来'],
      ['越用越准', '三件事都写回你的库（rec_06 / rec_07 / rec_08），下回同一个人再来，它已经认识他。数据越积越厚，判断就越像你自己会做的那个决定'],
    ],
    result: '三件事全部在智能体这层处理完：0 次响铃、0 次转接，你那边一条通知都没收到。你不在场的时候，它替你把事办了，这才是「代理」两个字的意思。',
    writeback: ['写回', 'rec_06 通话 · 培训机构代答婉拒　rec_07 好友申请 · 房产中介已拒绝　rec_08 代回 · 亲戚问科室，依 rec_04 作答'],
    stats: [['0', '次响铃'], ['0', '次转接'], ['3', '条写回']],
    forward: [
      ['命中', '来电落在你的实体表里，而且关系状态是「正在进行」：港大医院、你妻子'],
      ['对得上', '对方说的事只有你知道：时间、地点、金额跟你手上的记录对得上，但库里没有答案'],
      ['其余', '一律代答；实在答不了就留一句话在待办里，等你方便时再看'],
    ],
  },
  {
    variant: 'push',
    title: '时空上下文的消费场景四：提醒',
    trigger: ['2025.01.27 · 21:40', '除夕前 1 天', '票仍未支付', '你还在医院陪护'],
    from: 'Agent · 21:40',
    message: '明天除夕。你 1 月 26 日订的回老家高铁票还没付款；28 号那天你还排着医院陪护。要我帮你把票付掉吗？',
    actions: ['帮我付', '先不用'],
    why: [
      ['时间', '2025.01.28 是除夕，距今 1 天，正是「今天就得动手」的窗口'],
      ['状态', 'rec_05 那张票还是「未支付」，状态一直没闭合'],
      ['上下文', '港大医院陪护 2025.01.22 → 未知 仍在进行，明天要动身，今天必须定'],
    ],
  },

];

function Push({ card }) {
  return <>
    <div className="storage-block">
      <div className="storage-block-head">
        <strong>触发它的那几条数据</strong>
      </div>
      <div className="call-line">
        {card.trigger.map(chip => <span className="call-chip" key={chip}>{chip}</span>)}
      </div>
    </div>

    <div className="storage-block">
      <div className="storage-block-head">
        <strong>它主动发来的消息</strong>
      </div>
      <div className="push-msg">
        <div className="push-from">{card.from}</div>
        <div className="push-text">{card.message}</div>
        <div className="push-actions">
          {card.actions.map((action, i) => <span className={'push-action' + (i === 0 ? ' is-primary' : '')} key={action}>{action}</span>)}
        </div>
      </div>
    </div>

    <div className="storage-block">
      <div className="storage-block-head">
        <strong>触发原因</strong>
      </div>
      <div className="storage-prompt">
        {card.why.map(row => <div className="storage-prompt-row" key={row[0]}>
          <span>{row[0]}</span>
          <p>{row[1]}</p>
        </div>)}
      </div>
    </div>

  </>;
}

function Glyph({ kind }) {
  if (kind === 'contact') {
    return <svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true">
      <circle cx="20" cy="18" r="7" fill="none" stroke="#55554e" strokeWidth="1.4"/>
      <path d="M8 36c0-6.2 5.4-10 12-10s12 3.8 12 10" fill="none" stroke="#55554e" strokeWidth="1.4"/>
      <circle cx="36" cy="33" r="7.5" fill="#fbf4ea" stroke="#c9ab84" strokeWidth="1.2"/>
      <path d="M36 29.5v7M32.5 33h7" stroke="#8a5c28" strokeWidth="1.3"/>
    </svg>;
  }
  if (kind === 'chat') {
    return <svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true">
      <path d="M9 12h30v22H20l-8 6v-6H9z" fill="none" stroke="#55554e" strokeWidth="1.4"/>
      <path d="M16 21h16M16 27h10" stroke="#8a5c28" strokeWidth="1.3"/>
    </svg>;
  }
  return <svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true">
    <path d="M15 10c1.6-1.6 4-1.2 5 .8l2 3.2c.9 1.5.5 3.4-.9 4.5l-1.4 1.1c1.6 3.4 4.3 6.1 7.7 7.7l1.1-1.4c1.1-1.4 3-1.8 4.5-.9l3.2 2c2 1 2.4 3.4.8 5-2.2 2.2-5.5 3.4-8.6 2.4-7-2.3-12.6-7.9-14.9-14.9-1-3.1.2-6.4 2.4-8.6z" fill="none" stroke="#55554e" strokeWidth="1.4"/>
    <path d="M33 9c3.6 1.6 6.4 4.4 8 8" fill="none" stroke="#c9ab84" strokeWidth="1.3"/>
    <path d="M31 15c1.9.9 3.4 2.4 4.3 4.3" fill="none" stroke="#c9ab84" strokeWidth="1.3"/>
  </svg>;
}

function Gates({ card }) {
  return <>
    <div className="storage-block">
      <div className="storage-block-head">
        <strong>一天里来了三件事</strong>
      </div>
      <div className="case-grid">
        {card.cases.map(item => <div className="case" key={item.kind}>
          <div className="case-glyph"><Glyph kind={item.glyph} /></div>
          <span className="case-kind">{item.kind}</span>
          <p className="case-from">{item.from}</p>
          <p className="case-did">{item.did}</p>
          <span className="case-verdict">{item.verdict}</span>
        </div>)}
      </div>
    </div>

    <div className="storage-block">
      <div className="storage-block-head">
        <strong>它凭什么判断</strong>
      </div>
      <div className="storage-prompt">
        {card.rules.map(row => <div className="storage-prompt-row" key={row[0]}>
          <span>{row[0]}</span>
          <p>{row[1]}</p>
        </div>)}
      </div>
    </div>

    <div className="storage-block">
      <div className="storage-block-head">
        <strong>结果</strong>
      </div>
      <div className="quiet-line">{card.result}</div>
      <div className="quiet-back">
        <em>{card.writeback[0]}</em>{card.writeback[1]}
      </div>
      <div className="quiet-stats">
        {card.stats.map(item => <div key={item[1]}><strong>{item[0]}</strong><span>{item[1]}</span></div>)}
      </div>
    </div>

    <div className="storage-block">
      <div className="storage-block-head">
        <strong>什么时候才打扰你</strong>
      </div>
      <div className="storage-prompt">
        {card.forward.map(row => <div className="storage-prompt-row" key={row[0]}>
          <span>{row[0]}</span>
          <p>{row[1]}</p>
        </div>)}
      </div>
    </div>
  </>;
}

function Card({ card }) {
  return <section className="storage consumer" aria-label={card.title}>
    <div className="storage-head">
      <h3>{card.title}</h3>
    </div>

    {card.variant === 'gates' ? <Gates card={card} />
      : card.variant === 'push' ? <Push card={card} />
      : <div className="storage-block">
        <div className="storage-block-head">
          <strong>问题</strong>
        </div>
        <div className="consumer-question">{card.question}</div>
      </div>}

    {(card.steps || []).map(step => <div key={step.index}>
      <div className="storage-arrow"><i /></div>
      <div className="storage-block">
        <div className="storage-block-head">
          <strong>{step.index} {step.title}</strong>
        </div>
        <div className="storage-prompt">
          {step.rows.map(row => <div className="storage-prompt-row" key={row[0]}>
            <span>{row[0]}</span>
            <p>{row[1]}</p>
          </div>)}
        </div>
      </div>
    </div>)}
  </section>;
}

export default function ConsumerModel() {
  return <div id="usage">{cards.map(card => <Card key={card.title} card={card} />)}</div>;
}
