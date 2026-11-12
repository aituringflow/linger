const records = [
  { id: 'rec_01', source: '微信', type: '群聊', content: '妈：今年过年回不回来？腊肉都腌好了。', happened: '2024.11.20 21:07', captured: '2024.11.20 21:09' },
  { id: 'rec_02', source: '工商银行', type: '转账', content: '转给王秀兰 ¥2,000 · 备注「妈 生活费」', happened: '2024.12.08 09:14', captured: '2024.12.08 09:15' },
  { id: 'rec_03', source: '相册', type: '照片', content: '婚礼合照 · 背面手写「岳母张桂芳」', happened: '2023.05.06 11:20', captured: '2024.12.02 20:03' },
  { id: 'rec_04', source: '港大医院', type: '挂号单', content: '张桂芳 · 陪护 我 · 港大医院', happened: '2025.01.22 08:40', captured: '2025.01.22 08:41' },
  { id: 'rec_05', source: '携程', type: '行程', content: '「回老家」1月28日 高铁票 · 未支付', happened: '2025.01.28', captured: '2025.01.26 20:10' },
];

const extraction = [
  ['输入', 'rec_01 ·「妈：今年过年回不回来？腊肉都腌好了。」'],
  ['实体', '① 妈（人 · 称呼，未消歧）　② 我（人）'],
  ['不建实体', '腊肉（通用物品）　过年（时间，进时间字段）'],
  ['关系', '① 「妈」是我的母亲（待消歧）　② 妈在准备过年，腊肉已经腌好　③ 妈问我今年过年回不回来'],
];

const entities = [
  ['p_0001', '人', '我', '{"aliases":["我"]}', '2024.11', '已确认'],
  ['p_0187', '人', '王秀兰', '{"aliases":["妈"],"resolved_by":"rec_02"}', '2024.11', '已确认'],
  ['p_0264', '人', '张桂芳', '{"aliases":["岳母","妈"],"resolved_by":"rec_03"}', '2023.05', '已确认'],
  ['p_0301', '人', '妻子', '', '2023.05', '待补名'],
  ['org_0071', '组织', '港大医院', '', '2025.01', '已确认'],
  ['loc_0112', '地点', '老家', '', '2024.11', '已确认'],
];

const relations = [
  ['rec_01', '微信家庭群里的「妈」是我的母亲，还没确认是哪一个', '妈 / 我', '—', '—', '待消歧'],
  ['rec_01', '我妈在准备过年，腊肉已经腌好了', '妈 / 我', '2024.11.20', '未结束', '已确认'],
  ['rec_01', '我妈问我今年过年回不回来', '妈 / 我', '2024.11.20', '2024.11.20', '已确认'],
  ['rec_02', '我用工商银行 App 给我的母亲王秀兰转了 2,000 元，备注「妈 生活费」', '我 / 王秀兰', '2024.12.08', '2024.12.08', '已确认'],
  ['rec_03', '婚礼照片背面写着「岳母张桂芳」，所以张桂芳是我妻子的母亲，也是我的岳母', '我 / 张桂芳 / 妻子', '2023.05.06', '未结束', '已确认'],
  ['rec_04', '张桂芳在港大医院就诊，我在医院陪护她', '张桂芳 / 港大医院 / 我', '2025.01.22', '未知', '已确认'],
  ['rec_05', '我在携程订了 1 月 28 日回老家的高铁票，还没付款，那天是除夕', '我 / 老家', '2025.01.28', '2025.01.28', '待确认'],
];


export default function StorageModel() {
  return <section className="storage" id="storage" aria-label="时空上下文的存储">
    <div className="storage-head">
      <h3>时空上下文的存储方式</h3>
    </div>

    <div className="storage-block">
      <div className="storage-block-head">
        <strong>原始记录表</strong>
      </div>
      <div className="storage-table-wrap">
        <table className="storage-table">
          <thead>
            <tr>
              <th>id</th>
              <th>source</th>
              <th>type</th>
              <th>content</th>
              <th className="is-time">happened_at</th>
              <th>captured_at</th>
            </tr>
          </thead>
          <tbody>
            {records.map(row => <tr key={row.id}>
              <td className="is-id">{row.id}</td>
              <td>{row.source}</td>
              <td>{row.type}</td>
              <td className="is-content">{row.content}</td>
              <td className="is-time">{row.happened}</td>
              <td>{row.captured}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>

    <div className="storage-arrow">
      <span>抽取</span>
      <i />
    </div>

    <div className="storage-block">
      <div className="storage-block-head">
        <strong>抽取</strong>
      </div>
      <div className="storage-prompt">
        {extraction.map(row => <div className="storage-prompt-row" key={row[0]}>
          <span>{row[0]}</span>
          <p>{row[1]}</p>
        </div>)}
      </div>
    </div>

    <div className="storage-arrow">
      <span>落表</span>
      <i />
    </div>

    <div className="storage-block">
      <div className="storage-block-head">
        <strong>实体表</strong>
      </div>
      <div className="storage-table-wrap">
        <table className="storage-table storage-table-small">
          <thead>
            <tr>
              <th>id</th>
              <th>type</th>
              <th>name</th>
              <th>meta</th>
              <th>first_seen</th>
              <th>embedding</th>
              <th>status</th>
            </tr>
          </thead>
          <tbody>
            {entities.map(row => <tr key={row[0]}>
              <td className="is-id">{row[0]}</td>
              <td>{row[1]}</td>
              <td>{row[2]}</td>
              <td>{row[3]}</td>
              <td>{row[4]}</td>
              <td className="is-dim">embeddinggemma2 · 768</td>
              <td>{row[5]}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>

    <div className="storage-block">
      <div className="storage-block-head">
        <strong>关系表</strong>
      </div>
      <div className="storage-table-wrap">
        <table className="storage-table storage-table-small">
          <thead>
            <tr>
              <th>record</th>
              <th>描述</th>
              <th>涉及实体</th>
              <th className="is-time">valid_from</th>
              <th className="is-time">valid_to</th>
              <th>embedding</th>
              <th>status</th>
            </tr>
          </thead>
          <tbody>
            {relations.map(row => <tr key={row[1]}>
              <td className="is-id">{row[0]}</td>
              <td className="is-content">{row[1]}</td>
              <td>{row[2]}</td>
              <td className="is-time">{row[3]}</td>
              <td className="is-time">{row[4]}</td>
              <td className="is-dim">embeddinggemma2 · 768</td>
              <td>{row[5]}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>

  </section>;
}
