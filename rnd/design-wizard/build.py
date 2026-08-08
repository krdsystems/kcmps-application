#!/usr/bin/env python3
"""Re-inline assets/*.png into design-wizard-mockup.html from template.html.
Run: python3 build.py   (after editing template.html or regenerating assets)"""
import base64, os
HERE = os.path.dirname(os.path.abspath(__file__))
A = os.path.join(HERE, "assets")
b64 = lambda f: "data:image/png;base64," + base64.b64encode(open(os.path.join(A, f), "rb").read()).decode()
s = open(os.path.join(HERE, "template.html")).read()
rep = {"__SHIRT_FRONT__": b64("shirt-front.png"), "__SHIRT_FRONT_MASK__": b64("shirt-front-mask.png"),
       "__SHIRT_BACK__": b64("shirt-back.png"),   "__SHIRT_BACK_MASK__": b64("shirt-back-mask.png")}
for i in range(1, 9):
    rep["__D%d__" % i] = b64("design-%02d.png" % i)
for k, v in rep.items():
    s = s.replace(k, v)
out = os.path.join(HERE, "design-wizard-mockup.html")
open(out, "w").write(s)
print("wrote %s (%d KB)" % (out, len(s) // 1024))
