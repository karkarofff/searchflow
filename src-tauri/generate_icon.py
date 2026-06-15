from PIL import Image, ImageDraw
import os

def draw_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    s = size
    cx = s * 0.42
    cy = s * 0.42
    r_out = s * 0.36
    r_in = s * 0.28
    stroke = max(2, int(s * 0.08))
    draw.ellipse([cx-r_out, cy-r_out, cx+r_out, cy+r_out], fill=(108, 99, 255, 255))
    draw.ellipse([cx-r_in, cy-r_in, cx+r_in, cy+r_in], fill=(15, 17, 23, 255))
    lx1 = cx - r_in * 0.7
    lx2 = cx + r_in * 0.7
    ly1 = cy - r_in * 0.3
    ly2 = cy
    ly3 = cy + r_in * 0.3
    lw = max(1, int(s * 0.05))
    draw.line([lx1, ly1, lx2, ly1], fill=(108, 99, 255, 255), width=lw)
    draw.line([lx1, ly2, lx2, ly2], fill=(167, 139, 250, 255), width=lw)
    draw.line([lx1, ly3, int(lx2*0.85+lx1*0.15), ly3], fill=(108, 99, 255, 180), width=lw)
    x1 = int(cx + r_out * 0.65)
    y1 = int(cy + r_out * 0.65)
    x2 = int(s * 0.88)
    y2 = int(s * 0.88)
    draw.line([x1, y1, x2, y2], fill=(167, 139, 250, 255), width=stroke)
    return img

# On génère uniquement le PNG source 512x512 pour Tauri
img = draw_icon(512)
img.save('app-icon.png')
print('app-icon.png genere !')