# -*- coding: utf-8 -*-
"""跨学科字幕审计回归测试（不联网、不需要 cookie）。

造一门 5 分 P 的"高等数学"课，把 P2/P3 换成电竞解说字幕：
  · 必须判 mismatch 且只点名 P2/P3；
  · 全部换回数学字幕必须判 ok（不能误伤正常课程）；
  · 没有 meta/字幕时必须判 unverified（不能静默 ok）。
"""

import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pipeline"))
import vk_audit  # noqa: E402

COMMON = ("高等数学这门课研究函数、极限、导数、微分和积分。我们通过例题讲解定义、定理、"
          "计算方法和几何意义，这些内容是后面所有章节的基础。")

MATH = {
    1: COMMON * 6 + "同学们好，今天我们学习高等数学第一章函数与极限。首先看函数的定义域和值域，函数是刻画变量之间对应关系的工具。"
       "我们研究函数的单调性、奇偶性、周期性，这些性质对后面求极限很重要。",
    2: COMMON * 6 + "这一节讲数列极限和函数极限。极限是高等数学的基础，数列极限用 epsilon N 语言描述，函数极限要考虑左右极限。"
       "我们通过例题说明如何用定义证明极限，以及无穷小和无穷大的关系。",
    3: COMMON * 6 + "接下来讲函数的连续性。连续的定义是函数在一点的极限等于函数值，间断点分为第一类间断点和第二类间断点。"
       "连续函数在闭区间上有最大值最小值，这是后面定理的基础。",
    4: COMMON * 6 + "第二章导数与微分。导数刻画函数的变化率，几何意义是切线斜率。我们推导基本求导公式，讲复合函数求导的链式法则。"
       "微分是函数增量的线性主部，可导一定连续，连续不一定可导。",
    5: COMMON * 6 + "第三章不定积分。不定积分是求导的逆运算，基本积分公式要背熟。换元积分法和分部积分法是两大基本方法。"
       "我们通过大量例题练习，把被积函数化成基本积分表里的形式。",
}
ESPORTS = ("欢迎来到英雄联盟职业联赛的直播间，今天由我和嘉宾一起解说 WB 对阵 BLG 的焦点战。"
           "双方在第一局打得非常胶着，打野的节奏很好，下路组合的对线压制力很强。"
           "这一波团战 BLG 先手开团，WB 的射手输出环境很好，最后打出一换三，拿下大龙。"
           "感谢观看，记得点赞关注，我们下场比赛再见。")


def make_run(root, bad_parts):
    vdir = os.path.join(root, "TST1234567")
    if os.path.isdir(vdir):
        shutil.rmtree(vdir)
    os.makedirs(os.path.join(vdir, "by_p"))
    parts, off = [], 0
    for i in range(1, 6):
        parts.append({"index": i, "title": "P%d 高等数学 函数与极限" % i,
                      "durationSec": 600, "offsetSec": off})
        off += 600
        text = ESPORTS if i in bad_parts else MATH[i]
        text = text * (20 if i in bad_parts else 5)
        with open(os.path.join(vdir, "by_p", "p%02d.txt" % i), "w", encoding="utf-8") as fh:
            fh.write(text)
    meta = {"videoId": "TST1234567", "title": "宋浩 高等数学 第一章 函数与极限",
            "parts": parts, "totalDurationSec": off}
    with open(os.path.join(vdir, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False)
    return vdir


def main():
    root = tempfile.mkdtemp(prefix="vk-audit-test-")
    try:
        bad = vk_audit.audit_run(make_run(root, {2, 3}))
        assert bad["verdict"] == "mismatch", bad
        assert bad["mismatched"] == [2, 3], bad
        assert "2,3" in bad["warning"], bad

        good = vk_audit.audit_run(make_run(root, set()))
        assert good["verdict"] == "ok", good
        assert good["mismatched"] == [], good

        empty = os.path.join(root, "EMPTY123456")
        os.makedirs(empty)
        unknown = vk_audit.audit_run(empty)
        assert unknown["verdict"] == "unverified", unknown
        assert unknown["ok"] is False, unknown
        print("audit fixture PASS")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
