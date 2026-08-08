from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math, os
OUT=__import__("os").path.join(__import__("os").path.dirname(__import__("os").path.abspath(__file__)),"assets")
os.makedirs(OUT, exist_ok=True)
F="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FC="/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf"

W,H=900,1050

def shirt_mask(back=False):
    """alpha silhouette of a tee"""
    m=Image.new("L",(W,H),0); d=ImageDraw.Draw(m)
    cx=W//2
    # body
    body=[(cx-215,215),(cx+215,215),(cx+235,H-70),(cx-235,H-70)]
    d.polygon(body,fill=255)
    d.rounded_rectangle([cx-235,H-160,cx+235,H-60],radius=28,fill=255)
    # shoulders / sleeves
    d.polygon([(cx-215,215),(cx-330,265),(cx-395,455),(cx-260,505),(cx-215,375)],fill=255)
    d.polygon([(cx+215,215),(cx+330,265),(cx+395,455),(cx+260,505),(cx+215,375)],fill=255)
    d.rounded_rectangle([cx-400,300,cx-250,510],radius=45,fill=255)
    d.rounded_rectangle([cx+250,300,cx+400,510],radius=45,fill=255)
    # shoulder line smoothing
    d.rounded_rectangle([cx-230,205,cx+230,320],radius=40,fill=255)
    # collar
    if back:
        d.ellipse([cx-105,175,cx+105,255],fill=255)
        d.ellipse([cx-92,182,cx+92,236],fill=0)
    else:
        d.ellipse([cx-115,168,cx+115,262],fill=255)
        d.chord([cx-100,150,cx+100,300],0,180,fill=0)
    m=m.filter(ImageFilter.GaussianBlur(2))
    m=m.point(lambda p:255 if p>110 else 0)
    m=m.filter(ImageFilter.GaussianBlur(1.2))
    return m

def shading(mask, back=False):
    """grayscale shading map, white = no darkening"""
    s=Image.new("L",(W,H),250); d=ImageDraw.Draw(s)
    cx=W//2
    # side shadows (stronger, tapered)
    for i in range(170):
        t=(1-i/170)
        v=int(250-115*t**1.4)
        d.rectangle([cx-252+i,180,cx-252+i+1,H],fill=v)
        d.rectangle([cx+252-i,180,cx+252-i+1,H],fill=v)
    # sleeve inner shadow
    for x,sgn in ((cx-250,1),(cx+250,-1)):
        for i in range(70):
            v=int(250-95*(1-i/70)**1.3)
            d.rectangle([x+sgn*i-2,240,x+sgn*i+2,520],fill=v)
    # sleeve outer edges
    for i in range(45):
        v=int(250-85*(1-i/45)**1.2)
        d.rectangle([cx-400+i,300,cx-400+i+1,515],fill=v)
        d.rectangle([cx+400-i,300,cx+400-i+1,515],fill=v)
    # hem band
    d.rectangle([0,H-118,W,H-96],fill=205)
    d.rectangle([0,H-96,W,H],fill=228)
    # sleeve cuffs
    d.rectangle([cx-405,470,cx-245,505],fill=212)
    d.rectangle([cx+245,470,cx+405,505],fill=212)
    # folds
    for (fx,fy,fw,val) in [(cx-150,660,58,214),(cx+130,730,70,218),(cx-40,900,95,222),(cx+195,890,48,212),(cx-215,560,40,206)]:
        d.ellipse([fx-fw,fy-210,fx+fw,fy+210],fill=val)
    # chest/shoulder highlight
    d.ellipse([cx-160,300,cx+160,560],fill=255)
    # collar shadow
    d.ellipse([cx-135,150,cx+135,305],fill=200)
    if not back:
        d.chord([cx-106,156,cx+106,294],0,180,fill=248)
    s=s.filter(ImageFilter.GaussianBlur(19))
    # collar ribbing (crisp, after blur)
    d2=ImageDraw.Draw(s)
    if back:
        d2.ellipse([cx-107,177,cx+107,257],outline=196,width=9)
    else:
        d2.arc([cx-117,166,cx+117,264],0,180,fill=192,width=11)
        d2.arc([cx-117,152,cx+117,250],0,180,fill=225,width=6)
    s=s.filter(ImageFilter.GaussianBlur(2))
    img=Image.merge("RGBA",(s,s,s,mask))
    return img

for back in (False,True):
    m=shirt_mask(back)
    sh=shading(m,back)
    name="shirt-back" if back else "shirt-front"
    sh.save(f"{OUT}/{name}.png")
    Image.merge("RGBA",(Image.new("L",(W,H),255),)*3+(m,)).save(f"{OUT}/{name}-mask.png")

# ---------- sample designs (transparent PNGs) ----------
def design(fn, draw_fn, size=(760,760)):
    img=Image.new("RGBA",size,(0,0,0,0)); d=ImageDraw.Draw(img)
    draw_fn(d,img)
    img.save(f"{OUT}/{fn}.png")

def fit(d,text,maxw,path=F,start=200):
    s=start
    while s>10:
        f=ImageFont.truetype(path,s)
        if d.textlength(text,font=f)<=maxw: return f
        s-=4
    return ImageFont.truetype(path,10)

def ctext(d,y,text,color,maxw=680,path=F,stroke=0,sc=(0,0,0,255)):
    f=fit(d,text,maxw,path)
    w=d.textlength(text,font=f)
    d.text((380-w/2,y),text,font=f,fill=color,stroke_width=stroke,stroke_fill=sc)
    return f.size

def d1(d,img):  # MOBILE LEGENDS
    d.regular_polygon((380,300,215),5,rotation=0,fill=(242,136,46,255))
    d.regular_polygon((380,300,168),5,rotation=0,fill=(20,30,52,255))
    ctext(d,225,"MOBA",(242,136,46,255),maxw=250)
    ctext(d,545,"LEGENDS",(255,255,255,255),maxw=700)
    d.rectangle([90,690,670,712],fill=(242,136,46,255))
def d2(d,img):  # BRAWL
    d.rounded_rectangle([70,180,690,470],radius=40,fill=(216,60,60,255))
    ctext(d,215,"BRAWL",(255,255,255,255),maxw=560)
    ctext(d,500,"★ SQUAD GOALS ★",(255,255,255,255),maxw=640)
    ctext(d,600,"EST. MANILA",(216,60,60,255),maxw=380)
def d3(d,img):  # cat
    d.ellipse([180,220,580,600],fill=(255,255,255,255))
    d.polygon([(200,300),(230,140),(330,255)],fill=(255,255,255,255))
    d.polygon([(560,300),(530,140),(430,255)],fill=(255,255,255,255))
    d.ellipse([265,340,315,400],fill=(20,30,52,255)); d.ellipse([445,340,495,400],fill=(20,30,52,255))
    d.polygon([(360,430),(400,430),(380,460)],fill=(242,136,46,255))
    for sx in (150,470):
        for k in range(3):
            d.line([(sx+ (60 if sx<300 else 60),470+k*22),(sx+(-60 if sx<300 else 180),450+k*30)],fill=(255,255,255,255),width=7)
    ctext(d,630,"STAY WEIRD",(255,255,255,255),maxw=520)
def d4(d,img):  # typographic
    for i,(t,c) in enumerate([("HUSTLE",(255,255,255,255)),("HARDER",(242,136,46,255)),("THAN",(255,255,255,255)),("YESTERDAY",(255,255,255,255))]):
        ctext(d,120+i*150,t,c,maxw=700)
def d5(d,img):  # sun / native gold
    d.ellipse([190,150,570,530],fill=(230,180,60,255))
    for a in range(0,360,15):
        r=math.radians(a)
        d.line([(380+200*math.cos(r),340+200*math.sin(r)),(380+275*math.cos(r),340+275*math.sin(r))],fill=(230,180,60,255),width=14)
    d.ellipse([250,210,510,470],fill=(20,30,52,255))
    ctext(d,300,"1898",(230,180,60,255),maxw=200)
    ctext(d,620,"NATIVE GOLD",(230,180,60,255),maxw=640)
def d6(d,img):  # rubix
    cols=[(216,60,60,255),(242,136,46,255),(255,255,255,255),(74,157,92,255),(53,97,156,255),(230,180,60,255)]
    k=0
    for r in range(3):
        for c in range(3):
            d.rounded_rectangle([160+c*160,150+r*160,300+c*160,290+r*160],radius=18,fill=cols[k%6]); k+=1
    ctext(d,650,"SOLVE IT",(255,255,255,255),maxw=440)
def d7(d,img):  # miku-ish
    d.ellipse([230,180,530,540],fill=(90,200,205,255))
    d.rectangle([230,300,530,560],fill=(90,200,205,255))
    d.ellipse([255,330,325,420],fill=(20,30,52,255)); d.ellipse([435,330,505,420],fill=(20,30,52,255))
    d.rounded_rectangle([120,240,215,700],radius=40,fill=(90,200,205,255))
    d.rounded_rectangle([545,240,640,700],radius=40,fill=(90,200,205,255))
    ctext(d,620,"VIRTUAL",(255,255,255,255),maxw=380)
def d8(d,img):  # run
    ctext(d,150,"RUN",(242,136,46,255),maxw=520)
    ctext(d,400,"DON'T",(255,255,255,255),maxw=560)
    ctext(d,570,"WALK",(255,255,255,255),maxw=560)
    for i in range(6):
        d.rectangle([60,180+i*26,60+ (30+i*18),190+i*26],fill=(242,136,46,255))

for i,fn in enumerate([d1,d2,d3,d4,d5,d6,d7,d8],1):
    design(f"design-{i:02d}",fn)
print("ok")
