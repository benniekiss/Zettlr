local vars = {}

local function get_vars (meta)
  for k, v in pairs(meta) do
    if pandoc.utils.type(v) == 'Inlines' then
      vars["%" .. k .. "%"] = {table.unpack(v)}
    end
  end
end

local function replace (el)
  if vars[el.text] then
    return pandoc.Span(vars[el.text])
  else
    return el
  end
end

function Pandoc(doc)
  return doc:walk { Meta = get_vars }:walk { Str = replace }
end
